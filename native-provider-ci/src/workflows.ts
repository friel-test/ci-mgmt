import { z } from "zod";
import { GithubWorkflow, NormalJob } from "./github-workflow";
import * as steps from "./steps";
import { Step } from "./steps";

const pythonVersion = "3.7";
const goVersion = "1.21.x";
const nodeVersion = "16.x";
const dotnetVersion = "6.0.x\n3.1.301\n";
const javaVersion = "11";

export const WorkflowOpts = z.object({
  provider: z.string(),
  env: z.record(z.any()).optional(),
  docker: z.boolean().default(false),
  aws: z.boolean().default(false),
  gcp: z.boolean().default(false),
  submodules: z.boolean().default(false),
  lint: z.boolean().default(true),
  "setup-script": z.string().optional(),
  parallel: z.number().default(3),
  timeout: z.number().default(60),
  providerVersion: z.string().default(""),
  skipCodegen: z.boolean().default(false),
  skipWindowsArmBuild: z.boolean().default(false),
  pulumiCLIVersion: z.string().optional(),
});
type WorkflowOpts = z.infer<typeof WorkflowOpts>;

const env = (opts: WorkflowOpts) =>
  Object.assign(
    {
      GITHUB_TOKEN: "${{ secrets.PULUMI_BOT_TOKEN }}",
      PROVIDER: opts.provider,
      PULUMI_ACCESS_TOKEN: "${{ secrets.PULUMI_ACCESS_TOKEN }}",
      PULUMI_LOCAL_NUGET: "${{ github.workspace }}/nuget",
      NPM_TOKEN: "${{ secrets.NPM_TOKEN }}",
      NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
      NUGET_PUBLISH_KEY: "${{ secrets.NUGET_PUBLISH_KEY }}",
      PYPI_USERNAME: "__token__",
      PYPI_PASSWORD: "${{ secrets.PYPI_API_TOKEN }}",
      TRAVIS_OS_NAME: "linux",
      SLACK_WEBHOOK_URL: "${{ secrets.SLACK_WEBHOOK_URL }}",
      PULUMI_GO_DEP_ROOT: "${{ github.workspace }}/..",
      PUBLISH_REPO_USERNAME: "${{ secrets.OSSRH_USERNAME }}",
      PUBLISH_REPO_PASSWORD: "${{ secrets.OSSRH_PASSWORD }}",
      SIGNING_KEY_ID: "${{ secrets.JAVA_SIGNING_KEY_ID }}",
      SIGNING_KEY: "${{ secrets.JAVA_SIGNING_KEY }}",
      SIGNING_PASSWORD: "${{ secrets.JAVA_SIGNING_PASSWORD }}",
      GOVERSION: goVersion,
      NODEVERSION: nodeVersion,
      PYTHONVERSION: pythonVersion,
      DOTNETVERSION: dotnetVersion,
      JAVAVERSION: javaVersion,
    },
    opts.env
  );

// This section represents GHA files, sub-jobs are in a section below

// Creates command-dispatch.yml
export function CommandDispatchWorkflow(
  name: string,
  opts: WorkflowOpts
): GithubWorkflow {
  return {
    name: name,

    on: {
      issue_comment: {
        types: ["created", "edited"],
      },
    },
    env: env(opts),

    jobs: {
      "command-dispatch-for-testing": new EmptyJob(
        "command-dispatch-for-testing"
      )
        .addConditional("${{ github.event.issue.pull_request }}")
        .addStep(steps.CheckoutRepoStep())
        .addStep(steps.CommandDispatchStep(`${opts.provider}`)),
    },
  };
}

// Creates pull-request.yml
export function PullRequestWorkflow(
  name: string,
  opts: WorkflowOpts
): GithubWorkflow {
  return {
    name: name,
    on: {
      pull_request_target: {},
    },
    env: env(opts),
    jobs: {
      "comment-on-pr": new EmptyJob("comment-on-pr")
        .addConditional(
          "github.event.pull_request.head.repo.full_name != github.repository"
        )
        .addStep(steps.CheckoutRepoStep())
        .addStep(steps.CommentPRWithSlashCommandStep()),
    },
  };
}

// Creates run-acceptance-tests.yml
export function RunAcceptanceTestsWorkflow(
  name: string,
  opts: WorkflowOpts
): GithubWorkflow {
  const workflow: GithubWorkflow = {
    name: name,
    on: {
      repository_dispatch: {
        types: ["run-acceptance-tests-command"],
      },
      pull_request: {
        branches: ["master", "main"],
        "paths-ignore": ["CHANGELOG.md"],
      },
      workflow_dispatch: {},
    },
    env: {
      ...env(opts),
      PR_COMMIT_SHA: "${{ github.event.client_payload.pull_request.head.sha }}",
    },
    jobs: {
      "comment-notification": new EmptyJob("comment-notification")
        .addConditional("github.event_name == 'repository_dispatch'")
        .addStep(steps.CreateCommentsUrlStep())
        .addStep(steps.UpdatePRWithResultsStep()),
      prerequisites: new PrerequisitesJob(
        "prerequisites",
        opts
      ).addDispatchConditional(true),
      build_sdks: new BuildSdkJob("build_sdks", opts, false)
        .addDispatchConditional(true)
        .addRunsOn(opts.provider),
      test: new TestsJob("test", opts).addDispatchConditional(true),
      sentinel: new EmptyJob("sentinel")
        .addConditional(
          "github.event_name == 'repository_dispatch' || github.event.pull_request.head.repo.full_name == github.repository"
        )
        .addStep(steps.EchoSuccessStep())
        .addNeeds(calculateSentinelNeeds(opts.lint, opts.provider)),
    },
  };
  if (opts.provider === "kubernetes") {
    workflow.jobs = Object.assign(workflow.jobs, {
      "build-test-cluster": new BuildTestClusterJob(
        "build-test-cluster",
        opts
      ).addDispatchConditional(true),
    });
    workflow.jobs = Object.assign(workflow.jobs, {
      "destroy-test-cluster": new TeardownTestClusterJob(
        "teardown-test-cluster",
        opts
      ).addDispatchConditional(true),
    });
    workflow.jobs = Object.assign(workflow.jobs, {
      lint: new LintKubernetesJob("lint").addDispatchConditional(true),
    });
    workflow.on = Object.assign(workflow.on, {
      pull_request: {
        branches: ["master", "main", "v4"],
        "paths-ignore": ["CHANGELOG.md"],
      },
    });
  }
  return workflow;
}

function calculateSentinelNeeds(
  requiresLint: boolean,
  provider: string
): string[] {
  const needs: string[] = ["test"];

  if (requiresLint) {
    needs.push("lint");
  }

  if (provider === "kubernetes") {
    needs.push("destroy-test-cluster");
  }

  return needs;
}

// Creates build.yml
export function BuildWorkflow(
  name: string,
  opts: WorkflowOpts
): GithubWorkflow {
  const workflow: GithubWorkflow = {
    name: name,
    on: {
      push: {
        branches: ["master", "main", "feature-**"],
        "paths-ignore": ["CHANGELOG.md"],
        "tags-ignore": ["v*", "sdk/*", "**"],
      },
      workflow_dispatch: {},
    },
    env: env(opts),
    jobs: {
      prerequisites: new PrerequisitesJob("prerequisites", opts),
      build_sdks: new BuildSdkJob("build_sdks", opts, false).addRunsOn(
        opts.provider
      ),
      test: new TestsJob("test", opts),
      publish: new PublishPrereleaseJob("publish", opts),
      publish_sdk: new PublishSDKJob("publish_sdk"),
      publish_java_sdk: new PublishJavaSDKJob("publish_java_sdk"),
    },
  };
  if (opts.provider === "kubernetes") {
    workflow.jobs = Object.assign(workflow.jobs, {
      "build-test-cluster": new BuildTestClusterJob("build-test-cluster", opts),
    });
    workflow.jobs = Object.assign(workflow.jobs, {
      "destroy-test-cluster": new TeardownTestClusterJob(
        "teardown-test-cluster",
        opts
      ),
    });
    workflow.jobs = Object.assign(workflow.jobs, {
      lint: new LintKubernetesJob("lint").addDispatchConditional(true),
    });
  }
  return workflow;
}

// Creates prerelease.yml
export function PrereleaseWorkflow(
  name: string,
  opts: WorkflowOpts
): GithubWorkflow {
  const workflow: GithubWorkflow = {
    name: name,
    on: {
      push: {
        tags: ["v*.*.*-**"],
      },
    },
    env: {
      ...env(opts),
      IS_PRERELEASE: true,
    },
    jobs: {
      prerequisites: new PrerequisitesJob("prerequisites", opts),
      build_sdks: new BuildSdkJob("build_sdks", opts, true),
      test: new TestsJob("test", opts),
      publish: new PublishPrereleaseJob("publish", opts),
      publish_sdk: new PublishSDKJob("publish_sdk"),
      publish_java_sdk: new PublishJavaSDKJob("publish_java_sdk"),
    },
  };
  if (opts.provider === "kubernetes") {
    workflow.jobs = Object.assign(workflow.jobs, {
      "build-test-cluster": new BuildTestClusterJob("build-test-cluster", opts),
    });
    workflow.jobs = Object.assign(workflow.jobs, {
      "destroy-test-cluster": new TeardownTestClusterJob(
        "teardown-test-cluster",
        opts
      ),
    });
  }
  return workflow;
}

// Creates release.yml
export function ReleaseWorkflow(
  name: string,
  opts: WorkflowOpts
): GithubWorkflow {
  const workflow: GithubWorkflow = {
    name: name,
    on: {
      push: {
        tags: ["v*.*.*", "!v*.*.*-**"],
      },
    },
    env: env(opts),
    jobs: {
      prerequisites: new PrerequisitesJob("prerequisites", opts),
      build_sdks: new BuildSdkJob("build_sdks", opts, true),
      test: new TestsJob("test", opts),
      publish: new PublishJob("publish", opts),
      publish_sdk: new PublishSDKJob("publish_sdks"),
      publish_java_sdk: new PublishJavaSDKJob("publish_java_sdk"),
      tag_sdk: new TagSDKJob("tag_sdk"),
      dispatch_docs_build: new DocsBuildDispatchJob("dispatch_docs_build"),
    },
  };
  if (opts.provider === "kubernetes") {
    workflow.jobs = Object.assign(workflow.jobs, {
      "build-test-cluster": new BuildTestClusterJob("build-test-cluster", opts),
    });
    workflow.jobs = Object.assign(workflow.jobs, {
      "destroy-test-cluster": new TeardownTestClusterJob(
        "teardown-test-cluster",
        opts
      ),
    });
  }
  return workflow;
}

// Creates weekly-pulumi-update.yml
export function WeeklyPulumiUpdateWorkflow(
  name: string,
  opts: WorkflowOpts
): GithubWorkflow {
  const workflow: GithubWorkflow = {
    name: name,
    on: {
      schedule: [
        {
          cron: "35 12 * * 4",
        },
      ],
      workflow_dispatch: {},
    },
    env: env(opts),
    jobs: {
      "weekly-pulumi-update": new WeeklyPulumiUpdate(
        "weekly-pulumi-update",
        opts
      ),
    },
  };
  return workflow;
}

// creates nightly-sdk-generation.yml
export function NightlySdkGenerationWorkflow(
  name: string,
  opts: WorkflowOpts
): GithubWorkflow {
  return {
    name: name,
    on: {
      schedule: [
        {
          cron: "35 4 * * 1-5",
        },
      ],
      workflow_dispatch: {},
    },
    env: env(opts),
    jobs: {
      "generate-sdk": new NightlySdkGeneration("generate-sdk", opts),
    },
  };
}

// creates cf2pulumi-release.yml
export function Cf2PulumiReleaseWorkflow(
  name: string,
  opts: WorkflowOpts
): GithubWorkflow {
  return {
    name: name,
    on: {
      push: {
        tags: ["v*.*.*", "!v*.*.*-**"],
      },
    },
    env: env(opts),
    jobs: {
      release: new Cf2PulumiRelease("release"),
    },
  };
}

// creates arm2pulumi-coverage-report.yml
export function Arm2PulumiCoverageReportWorkflow(
  name: string,
  opts: WorkflowOpts
): GithubWorkflow {
  return {
    name: name,
    on: {
      schedule: [
        {
          cron: "35 17 * * *",
        },
      ],
      workflow_dispatch: {},
    },
    env: env(opts),
    jobs: {
      "generate-coverage": new Arm2PulumiCoverageReport("coverage-report"),
    },
  };
}

// creates arm2pulumi-release.yml
export function Arm2PulumiReleaseWorkflow(
  name: string,
  opts: WorkflowOpts
): GithubWorkflow {
  return {
    name: name,
    on: {
      push: {
        tags: ["v*.*.*", "!v*.*.*-**"],
      },
      workflow_dispatch: {
        inputs: {
          version: {
            description:
              "The version of the binary to deploy - do not include the pulumi prefix in the name.",
            required: true,
            type: "string",
          },
        },
      },
    },
    env: env(opts),
    jobs: {
      release: new Arm2PulumiRelease("release"),
    },
  };
}

// This section represents sub-jobs that may be used in more than one workflow

export class BuildSdkJob implements NormalJob {
  needs = "prerequisites";

  "runs-on" = "pulumi-ubuntu-8core"; // insufficient resources to run Go builds on ubuntu-latest

  strategy = {
    "fail-fast": true,
    matrix: {
      language: ["nodejs", "python", "dotnet", "go", "java"],
    },
  };
  steps: NormalJob["steps"];
  name: string;
  if: NormalJob["if"];

  constructor(name: string, opts: WorkflowOpts, tag: boolean) {
    if (opts.provider === "azure-native") {
      this["runs-on"] =
        "${{ matrix.language == 'dotnet' && 'macos-11' || 'ubuntu-latest' }}";
    }
    this.name = name;
    this.steps = [
      steps.CheckoutRepoStep(),
      steps.CheckoutScriptsRepoStep(),
      steps.CheckoutTagsStep(),
      steps.InstallGo(),
      steps.InstallPulumiCtl(),
      steps.InstallPulumiCli(opts.pulumiCLIVersion),
      steps.InstallNodeJS(),
      steps.InstallDotNet(),
      steps.InstallPython(),
      steps.InstallJava(),
      steps.InstallGradle("7.6"),
      steps.DownloadProviderBinaries(opts.provider, name),
      steps.UnTarProviderBinaries(opts.provider, name),
      steps.RestoreBinaryPerms(opts.provider, name),
      steps.CodegenDuringSDKBuild(opts.provider),
      steps.InitializeSubModules(opts.submodules),
      steps.GenerateSDKs(opts.provider),
      steps.BuildSDKs(opts.provider),
      steps.CheckCleanWorkTree(),
      steps.Porcelain(),
      steps.ZipSDKsStep(),
      steps.UploadSDKs(tag),
      steps.NotifySlack("Failure while building SDKs"),
    ].filter((step: Step) => step.uses !== undefined || step.run !== undefined);
    Object.assign(this, { name });
  }

  addDispatchConditional(isWorkflowDispatch: boolean) {
    if (isWorkflowDispatch) {
      this.if =
        "github.event_name == 'repository_dispatch' || github.event.pull_request.head.repo.full_name == github.repository";

      this.steps = this.steps?.filter((step) => step.name !== "Checkout Repo");
      this.steps?.unshift(steps.CheckoutRepoStepAtPR());
    }
    return this;
  }

  addRunsOn(provider: string) {
    if (provider === "azure-native") {
      this["runs-on"] =
        "${{ matrix.language == 'dotnet' && 'macos-11' || 'ubuntu-latest' }}";
    }
    return this;
  }
}

export class PrerequisitesJob implements NormalJob {
  "runs-on" = "ubuntu-latest";
  steps: NormalJob["steps"];
  name: string;
  if: NormalJob["if"];

  constructor(name: string, opts: WorkflowOpts) {
    this.name = name;
    this.steps = [
      steps.CheckoutRepoStep(),
      steps.CheckoutScriptsRepoStep(),
      steps.CheckoutTagsStep(),
      steps.InstallGo(),
      steps.InstallPulumiCtl(),
      steps.InstallPulumiCli(opts.pulumiCLIVersion),
      steps.InstallSchemaChecker(opts.provider),
      steps.BuildK8sgen(opts.provider),
      steps.PrepareOpenAPIFile(opts.provider),
      steps.InitializeSubModules(opts.submodules),
      steps.BuildCodegenBinaries(opts.provider),
      steps.BuildSchema(opts.provider),
      steps.MakeKubernetesProvider(opts.provider),
      steps.CheckSchemaChanges(opts.provider),
      steps.CommentSchemaChangesOnPR(opts.provider),
      steps.LabelIfNoBreakingChanges(opts.provider),
      steps.BuildProvider(opts.provider),
      steps.CheckCleanWorkTree(),
      steps.Porcelain(),
      steps.TarProviderBinaries(),
      steps.UploadProviderBinaries(),
      steps.TestProviderLibrary(),
      steps.Codecov(),
      steps.NotifySlack("Failure in building provider prerequisites"),
    ].filter((step: Step) => step.uses !== undefined || step.run !== undefined);
    Object.assign(this, { name });
  }

  addDispatchConditional(isWorkflowDispatch: boolean) {
    if (isWorkflowDispatch) {
      this.if =
        "github.event_name == 'repository_dispatch' || github.event.pull_request.head.repo.full_name == github.repository";

      this.steps = this.steps?.filter((step) => step.name !== "Checkout Repo");
      this.steps?.unshift(steps.CheckoutRepoStepAtPR());
    }
    return this;
  }
}

export class TestsJob implements NormalJob {
  "runs-on" = "pulumi-ubuntu-8core"; // insufficient resources to run Go builds on ubuntu-latest, specifically for K8S

  needs = ["build_sdks"];
  strategy = {
    "fail-fast": true,
    matrix: {
      language: ["nodejs", "python", "dotnet", "go", "java"],
    },
  };
  permissions: NormalJob["permissions"];
  steps: NormalJob["steps"];
  name: string;
  if: NormalJob["if"];

  constructor(name: string, opts: WorkflowOpts) {
    if (opts.provider === "kubernetes") {
      this.needs = ["build_sdks", "build-test-cluster"];
    }
    this.name = name;
    this.permissions = {
      contents: "read",
      "id-token": "write",
    };
    this.steps = [
      steps.CheckoutRepoStep(),
      steps.CheckoutScriptsRepoStep(),
      steps.CheckoutTagsStep(),
      steps.InstallGo(),
      steps.InstallPulumiCtl(),
      steps.InstallPulumiCli(opts.pulumiCLIVersion),
      steps.InstallNodeJS(),
      steps.InstallDotNet(),
      steps.InstallPython(),
      steps.InstallJava(),
      steps.InstallGradle("7.6"),
      steps.DownloadProviderBinaries(opts.provider, name),
      steps.UnTarProviderBinaries(opts.provider, name),
      steps.RestoreBinaryPerms(opts.provider, name),
      steps.DownloadSDKs(),
      steps.UnzipSDKs(),
      steps.UpdatePath(),
      steps.InstallNodeDeps(),
      steps.SetNugetSource(),
      steps.InstallPythonDeps(),
      steps.InstallSDKDeps(),
      steps.MakeKubeDir(opts.provider),
      steps.DownloadKubeconfig(opts.provider),
      steps.ConfigureAwsCredentialsForTests(opts.aws),
      steps.GoogleAuth(opts.gcp),
      steps.SetupGCloud(opts.gcp),
      steps.InstallKubectl(opts.provider),
      steps.InstallandConfigureHelm(opts.provider),
      steps.SetupGotestfmt(),
      steps.RunTests(opts.provider),
      steps.NotifySlack("Failure in SDK tests"),
    ].filter((step: Step) => step.uses !== undefined || step.run !== undefined);
    Object.assign(this, { name });
  }

  addDispatchConditional(isWorkflowDispatch: boolean) {
    if (isWorkflowDispatch) {
      this.if =
        "github.event_name == 'repository_dispatch' || github.event.pull_request.head.repo.full_name == github.repository";

      this.steps = this.steps?.filter((step) => step.name !== "Checkout Repo");
      this.steps?.unshift(steps.CheckoutRepoStepAtPR());
    }
    return this;
  }
}

export class BuildTestClusterJob implements NormalJob {
  "runs-on" = "ubuntu-latest";
  steps: NormalJob["steps"];
  name: string;
  if: NormalJob["if"];
  outputs: NormalJob["outputs"];
  permissions: NormalJob["permissions"];

  constructor(name: string, opts: WorkflowOpts) {
    this.name = name;
    this.outputs = {
      "stack-name": "${{ steps.stackname.outputs.stack-name }}",
    };
    this.permissions = {
      contents: "read",
      "id-token": "write",
    };
    this.steps = [
      steps.CheckoutRepoStep(),
      steps.InstallGo(),
      steps.InstallPulumiCli(opts.pulumiCLIVersion),
      steps.InstallNodeJS(),
      steps.GoogleAuth(opts.gcp),
      steps.SetupGCloud(opts.gcp),
      steps.InstallKubectl(opts.provider),
      steps.LoginGoogleCloudRegistry(opts.provider),
      steps.SetStackName(opts.provider),
      steps.CreateTestCluster(opts.provider),
      steps.UploadKubernetesArtifacts(opts.provider),
    ].filter((step: Step) => step.uses !== undefined || step.run !== undefined);
    Object.assign(this, { name });
  }

  addDispatchConditional(isWorkflowDispatch: boolean) {
    if (isWorkflowDispatch) {
      this.if =
        "github.event_name == 'repository_dispatch' || github.event.pull_request.head.repo.full_name == github.repository";

      this.steps = this.steps?.filter((step) => step.name !== "Checkout Repo");
      this.steps?.unshift(steps.CheckoutRepoStepAtPR());
    }
    return this;
  }
}

export class TeardownTestClusterJob implements NormalJob {
  "runs-on" = "ubuntu-latest";
  steps: NormalJob["steps"];
  name: string;
  if: NormalJob["if"];
  needs: NormalJob["needs"];
  permissions: NormalJob["permissions"];

  constructor(name: string, opts: WorkflowOpts) {
    this.name = name;
    this.needs = ["build-test-cluster", "test"];
    this.if =
      "${{ always() }} && github.event.pull_request.head.repo.full_name == github.repository";
    this.permissions = {
      contents: "read",
      "id-token": "write",
    };
    this.steps = [
      steps.CheckoutRepoStep(),
      steps.InstallGo(),
      steps.InstallPulumiCli(opts.pulumiCLIVersion),
      steps.InstallNodeJS(),
      steps.GoogleAuth(opts.gcp),
      steps.SetupGCloud(opts.gcp),
      steps.InstallKubectl(opts.provider),
      steps.LoginGoogleCloudRegistry(opts.provider),
      steps.DestroyTestCluster(opts.provider),
      steps.DeleteArtifact(opts.provider),
    ].filter((step: Step) => step.uses !== undefined || step.run !== undefined);
    Object.assign(this, { name });
  }

  addDispatchConditional(isWorkflowDispatch: boolean) {
    if (isWorkflowDispatch) {
      this.steps = this.steps?.filter((step) => step.name !== "Checkout Repo");
      this.steps?.unshift(steps.CheckoutRepoStepAtPR());
    }
    return this;
  }
}

export class LintKubernetesJob implements NormalJob {
  "runs-on" = "ubuntu-latest";
  steps = [steps.CheckoutRepoStep(), steps.InstallGo(), steps.GolangciLint()];
  name: string;
  if: NormalJob["if"];

  constructor(name: string) {
    this.name = name;
    Object.assign(this, { name });
  }

  addDispatchConditional(isWorkflowDispatch: boolean) {
    if (isWorkflowDispatch) {
      this.if =
        "github.event_name == 'repository_dispatch' || github.event.pull_request.head.repo.full_name == github.repository";

      this.steps = this.steps.filter(
        (step: Step) => step.name !== "Checkout Repo"
      );
      this.steps.unshift(steps.CheckoutRepoStepAtPR());
    }
    return this;
  }
}

export class PublishPrereleaseJob implements NormalJob {
  "runs-on" = "ubuntu-latest";
  needs = "test";
  steps: NormalJob["steps"];
  name: string;
  constructor(name: string, opts: WorkflowOpts) {
    if (opts.provider === "azure-native" || opts.provider === "aws-native") {
      this["runs-on"] = "macos-11";
    }
    this.name = name;
    this.steps = [
      steps.CheckoutRepoStep(),
      steps.CheckoutTagsStep(),
      steps.InstallGo(),
      steps.InstallPulumiCtl(),
      steps.InstallPulumiCli(opts.pulumiCLIVersion),
      steps.ConfigureAwsCredentialsForPublish(),
      steps.SetPreReleaseVersion(),
      steps.RunGoReleaserWithArgs(
        `-p ${opts.parallel} -f .goreleaser.prerelease.yml --rm-dist --skip-validate --timeout ${opts.timeout}m0s`
      ),
      steps.NotifySlack("Failure in publishing binaries"),
    ];
    Object.assign(this, { name });
  }
}

export class PublishJob implements NormalJob {
  "runs-on" = "ubuntu-latest";
  needs = "test";
  name: string;
  steps: NormalJob["steps"];

  constructor(name: string, opts: WorkflowOpts) {
    this.name = name;
    Object.assign(this, { name });
    if (opts.provider === "azure-native" || opts.provider === "aws-native") {
      this["runs-on"] = "macos-11";
    }
    this.steps = [
      steps.CheckoutRepoStep(),
      steps.CheckoutTagsStep(),
      steps.InstallGo(),
      steps.InstallPulumiCtl(),
      steps.InstallPulumiCli(opts.pulumiCLIVersion),
      steps.ConfigureAwsCredentialsForPublish(),
      steps.SetPreReleaseVersion(),
      steps.RunGoReleaserWithArgs(
        `-p ${opts.parallel} release --rm-dist --timeout ${opts.timeout}m0s`
      ),
      steps.NotifySlack("Failure in publishing binaries"),
    ];
  }
}

export class PublishSDKJob implements NormalJob {
  "runs-on" = "ubuntu-latest";
  needs = "publish";
  name: string;
  steps: NormalJob["steps"];

  constructor(name: string) {
    this.name = name;
    Object.assign(this, { name });
    this.steps = [
      steps.CheckoutRepoStep(),
      steps.CheckoutScriptsRepoStep(),
      steps.CheckoutTagsStep(),
      steps.InstallGo(),
      steps.InstallPulumiCtl(),
      steps.InstallPulumiCli(),
      steps.InstallNodeJS(),
      steps.InstallDotNet(),
      steps.InstallPython(),
      steps.DownloadSpecificSDKStep("python"),
      steps.UnzipSpecificSDKStep("python"),
      steps.DownloadSpecificSDKStep("dotnet"),
      steps.UnzipSpecificSDKStep("dotnet"),
      steps.DownloadSpecificSDKStep("nodejs"),
      steps.UnzipSpecificSDKStep("nodejs"),
      steps.InstallTwine(),
      steps.RunPublishSDK(),
      steps.NotifySlack("Failure in publishing SDK"),
    ];
  }
}

export class PublishJavaSDKJob implements NormalJob {
  "runs-on" = "ubuntu-latest";
  "continue-on-error" = true;
  needs = "publish";
  name: string;
  steps: NormalJob["steps"];

  constructor(name: string) {
    this.name = name;
    Object.assign(this, { name });
    this.steps = [
      steps.CheckoutRepoStep(),
      steps.CheckoutScriptsRepoStep(),
      steps.CheckoutTagsStep(),
      steps.InstallGo(),
      steps.InstallPulumiCtl(),
      steps.InstallPulumiCli(),
      steps.InstallJava(),
      steps.InstallGradle("7.6"),
      steps.DownloadSpecificSDKStep("java"),
      steps.UnzipSpecificSDKStep("java"),
      steps.SetPackageVersionToEnv(),
      steps.RunPublishJavaSDK(),
    ];
  }
}

export class TagSDKJob implements NormalJob {
  "runs-on" = "ubuntu-latest";
  needs = "publish_sdk";
  steps = [
    steps.CheckoutRepoStep(),
    steps.InstallPulumiCtl(),
    steps.TagSDKTag(),
  ];
  name: string;

  constructor(name: string) {
    this.name = name;
    Object.assign(this, { name });
  }
}

export class DocsBuildDispatchJob implements NormalJob {
  "runs-on" = "ubuntu-latest";
  needs = "tag_sdk";
  steps = [steps.InstallPulumiCtl(), steps.DispatchDocsBuildEvent()];
  name: string;

  constructor(name: string) {
    this.name = name;
    Object.assign(this, { name });
  }
}

export class Cf2PulumiRelease implements NormalJob {
  "runs-on" = "macos-11";
  steps = [
    steps.CheckoutRepoStep(),
    steps.CheckoutTagsStep(),
    steps.InstallPulumiCtl(),
    steps.InstallGo(goVersion),
    steps.RunGoReleaserWithArgs(
      "-p 1 -f .goreleaser.cf2pulumi.yml release --rm-dist --timeout 60m0s"
    ),
    steps.ChocolateyPackageDeployment(),
  ];
  name: string;

  constructor(name: string) {
    this.name = name;
    Object.assign(this, { name });
  }
}

export class Arm2PulumiRelease implements NormalJob {
  "runs-on" = "macos-11";
  steps = [
    steps.CheckoutRepoStep(),
    steps.CheckoutTagsStep(),
    steps.InstallPulumiCtl(),
    steps.InstallGo(goVersion),
    steps.SetVersionIfAvailable(),
    steps.RunGoReleaserWithArgs(
      "-p 1 -f .goreleaser.arm2pulumi.yml release --rm-dist --timeout 60m0s"
    ),
  ];
  name: string;

  constructor(name: string) {
    this.name = name;
    Object.assign(this, { name });
  }
}

export class Arm2PulumiCoverageReport implements NormalJob {
  "runs-on" = "ubuntu-latest";
  steps = [
    steps.CheckoutRepoStep(),
    steps.InstallGo(goVersion),
    steps.InstallPulumiCtl(),
    steps.InstallPulumiCli(),
    steps.AzureLogin("azure-native"),
    steps.MakeClean(),
    steps.InitializeSubModules(true),
    steps.BuildCodegenBinaries("azure-native"),
    steps.MakeLocalGenerate(),
    steps.BuildProvider("azure-native"),
    steps.GenerateCoverageReport(),
    steps.TestResultsJSON(),
    steps.AwsCredentialsForArmCoverageReport(),
    steps.UploadArmCoverageToS3(),
  ];
  name: string;

  constructor(name: string) {
    this.name = name;
    Object.assign(this, { name });
  }
}

export class WeeklyPulumiUpdate implements NormalJob {
  "runs-on" = "ubuntu-latest";
  steps: NormalJob["steps"];
  if: NormalJob["if"];
  constructor(name: string, opts: WorkflowOpts) {
    this.steps = [
      steps.CheckoutRepoStep(),
      steps.CheckoutTagsStep(),
      steps.InstallGo(),
      steps.InstallPulumiCtl(),
      steps.InstallPulumiCli(opts.pulumiCLIVersion),
      steps.InstallDotNet(),
      steps.InstallNodeJS(),
      steps.InstallPython(),
      steps.UpdatePulumi(),
      steps.InitializeSubModules(opts.submodules),
      steps.ProviderWithPulumiUpgrade(opts.provider),
      steps.CreateUpdatePulumiPR(),
      // steps.SetPRAutoMerge(opts.provider),
    ].filter((step: Step) => step.uses !== undefined || step.run !== undefined);
    Object.assign(this, { name });
  }
}

export class NightlySdkGeneration implements NormalJob {
  "runs-on" = "ubuntu-latest";
  steps: NormalJob["steps"];
  name: string;
  if: NormalJob["if"];

  constructor(name: string, opts: WorkflowOpts) {
    this.name = name;
    this.steps = [
      steps.CheckoutRepoStep(),
      // Pass the provider here as an option so that it can be skipped if not needed
      steps.CheckoutTagsStep(opts.provider),
      steps.InstallGo(goVersion),
      steps.InstallPulumiCtl(),
      steps.InstallPulumiCli(opts.pulumiCLIVersion),
      steps.ConfigureAwsCredentialsForTests(opts.aws),
      steps.AzureLogin(opts.provider),
      steps.MakeClean(),
      steps.PrepareGitBranchForSdkGeneration(),
      steps.CommitEmptySDK(),
      steps.UpdateSubmodules(opts.provider),
      steps.MakeDiscovery(opts.provider),
      steps.BuildCodegenBinaries(opts.provider),
      steps.MakeLocalGenerate(),
      steps.SetGitSubmoduleCommitHash(opts.provider),
      steps.CommitAutomatedSDKUpdates(opts.provider),
      steps.PullRequestSdkGeneration(opts.provider),
      // steps.SetPRAutoMerge(opts.provider),
      steps.NotifySlack("Failure during automated SDK generation"),
    ].filter((step: Step) => step.uses !== undefined || step.run !== undefined);
    Object.assign(this, { name });
  }
}

export class EmptyJob implements NormalJob {
  steps: Step[];
  "runs-on" = "ubuntu-latest";
  strategy: NormalJob["strategy"];
  name: string;
  if?: string;
  needs?: string[];

  constructor(name: string, params?: Partial<NormalJob>) {
    this.name = name;
    this.steps = [];
    Object.assign(this, { name }, params);
  }

  addStep(step: Step) {
    this.steps.push(step);
    return this;
  }

  addStrategy(strategy: NormalJob["strategy"]) {
    this.strategy = strategy;
    return this;
  }

  addConditional(conditional: string) {
    this.if = conditional;
    return this;
  }

  addNeeds(name: string[]) {
    this.needs = name;
    return this;
  }
}
