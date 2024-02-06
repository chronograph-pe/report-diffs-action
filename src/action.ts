import { setFailed } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import {
  DEFAULT_EXECUTION_OPTIONS,
  METICULOUS_LOGGER_NAME,
  setMeticulousLocalDataDir,
} from "@alwaysmeticulous/common";
import { executeTestRun } from "@alwaysmeticulous/replay-orchestrator-launcher";
import { RunningTestRunExecution } from "@alwaysmeticulous/sdk-bundles-api";
import { initSentry } from "@alwaysmeticulous/sentry";
import debounce from "lodash.debounce";
import log from "loglevel";
import { addLocalhostAliases } from "./utils/add-localhost-aliases";
import { throwIfCannotConnectToOrigin } from "./utils/check-connection";
import { LOGICAL_ENVIRONMENT_VERSION } from "./utils/constants";
import { safeEnsureBaseTestsExists } from "./utils/ensure-base-exists.utils";
import { getEnvironment } from "./utils/environment.utils";
import { getBaseAndHeadCommitShas } from "./utils/get-base-and-head-commit-shas";
import { getCodeChangeEvent } from "./utils/get-code-change-event";
import { getInputs } from "./utils/get-inputs";
import { initLogger, setLogLevel, shortSha } from "./utils/logger.utils";
import { spinUpProxyIfNeeded } from "./utils/proxy";
import { ResultsReporter } from "./utils/results-reporter";
import { waitForDeploymentUrl } from "./utils/wait-for-deployment-url";

const EXECUTION_OPTIONS = {
  ...DEFAULT_EXECUTION_OPTIONS,
  noSandbox: true,
};

export const runMeticulousTestsAction = async (): Promise<void> => {
  initLogger();

  // Init Sentry without sampling traces on the action run.
  // Children processes, (test run executions) will use
  // the global sample rate.
  const sentryHub = await initSentry("report-diffs-action-v1", 1.0);

  const transaction = sentryHub.startTransaction({
    name: "report-diffs-action.runMeticulousTestsAction",
    description: "Run Meticulous tests action",
    op: "report-diffs-action.runMeticulousTestsAction",
  });

  if (+(process.env["RUNNER_DEBUG"] ?? "0")) {
    setLogLevel("trace");
  }

  const {
    apiToken,
    githubToken,
    appUrl,
    testsFile,
    maxRetriesOnFailure,
    parallelTasks,
    localhostAliases,
    maxAllowedColorDifference,
    maxAllowedProportionOfChangedPixels,
    useDeploymentUrl,
    allowedEnvironments,
    testSuiteId,
  } = getInputs();
  const { payload } = context;
  const event = getCodeChangeEvent(context.eventName, payload);
  const { owner, repo } = context.repo;
  const octokit = getOctokitOrFail(githubToken);
  const logger = log.getLogger(METICULOUS_LOGGER_NAME);

  if (event == null) {
    logger.warn(
      `Running report-diffs-action is only supported for 'push', \
      'pull_request' and 'workflow_dispatch' events, but was triggered \
      on a '${context.eventName}' event. Skipping execution.`
    );
    return;
  }

  const { base, head } = await getBaseAndHeadCommitShas(event, {
    useDeploymentUrl,
  });
  const environment = getEnvironment({ event, head });

  const { shaToCompareAgainst } = await safeEnsureBaseTestsExists({
    event,
    apiToken,
    base,
    context,
    octokit,
  });

  if (shaToCompareAgainst != null && event.type === "pull_request") {
    logger.info(
      `Comparing visual snapshots for the commit head of this PR, ${shortSha(
        head
      )}, against ${shortSha(shaToCompareAgainst)}`
    );
  } else if (shaToCompareAgainst != null) {
    logger.info(
      `Comparing visual snapshots for commit ${shortSha(
        head
      )} against commit ${shortSha(shaToCompareAgainst)}}`
    );
  } else {
    logger.info(`Generating visual snapshots for commit ${shortSha(head)}`);
  }

  const resultsReporter = new ResultsReporter({
    octokit,
    event,
    owner,
    repo,
    headSha: head,
    baseSha: shaToCompareAgainst,
    baseRef:
      event.type === "pull_request"
        ? event.payload.pull_request.base.ref
        : null,
    testSuiteId,
  });

  try {
    setMeticulousLocalDataDir();
    const reportTestFinished = debounce(
      (testRun: RunningTestRunExecution) =>
        resultsReporter.testFinished(testRun),
      5_000,
      {
        leading: false,
        trailing: true,
        maxWait: 15_000,
      }
    );
    await addLocalhostAliases({ appUrl, localhostAliases });

    const urlToTestAgainst = useDeploymentUrl
      ? await waitForDeploymentUrl({
          owner,
          repo,
          commitSha: head,
          octokit,
          sentryHub,
          transaction,
          allowedEnvironments,
        })
      : appUrl;

    if (urlToTestAgainst != null) {
      spinUpProxyIfNeeded(urlToTestAgainst, logger);
      await throwIfCannotConnectToOrigin(urlToTestAgainst);
    }

    const results = await executeTestRun({
      testsFile,
      apiToken,
      commitSha: head,
      baseCommitSha: shaToCompareAgainst,
      baseTestRunId: null,
      appUrl: urlToTestAgainst,
      executionOptions: EXECUTION_OPTIONS,
      screenshottingOptions: {
        enabled: true,
        storyboardOptions: { enabled: true },
        diffOptions: {
          diffThreshold: maxAllowedProportionOfChangedPixels,
          diffPixelThreshold: maxAllowedColorDifference,
        },
      },
      parallelTasks,
      maxRetriesOnFailure,
      rerunTestsNTimes: 0,
      githubSummary: true,
      environment,
      onTestRunCreated: (testRun) => resultsReporter.testRunStarted(testRun),
      onTestFinished: reportTestFinished,
      maxSemanticVersionSupported: 1,
      logicalEnvironmentVersion: LOGICAL_ENVIRONMENT_VERSION,
    });
    reportTestFinished.cancel();
    await resultsReporter.testRunFinished(results);

    transaction.setStatus("ok");
    transaction.finish();

    await sentryHub.getClient()?.close(5_000);

    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    setFailed(message);
    await resultsReporter.errorRunningTests();

    transaction.setStatus("unknown_error");
    transaction.finish();

    await sentryHub.getClient()?.close(5_000);

    process.exit(1);
  }
};

const getOctokitOrFail = (githubToken: string | null) => {
  if (githubToken == null) {
    throw new Error("github-token is required");
  }

  try {
    return getOctokit(githubToken);
  } catch (err) {
    const logger = log.getLogger(METICULOUS_LOGGER_NAME);
    logger.error(err);
    throw new Error(
      "Error connecting to GitHub. Did you specify a valid 'github-token'?"
    );
  }
};
