# @aws-blocks/pipeline

CDK Pipelines-based CI/CD construct for AWS Blocks applications.

Creates one self-mutating CodePipeline V2 per branch. Each pipeline:

- Pulls source from GitHub via AWS CodeConnections (OAuth, no tokens)
- Runs a synth step (install + `cdk synth`)
- Self-mutates if the pipeline definition changes
- Deploys to ordered stages with optional manual approval and bake time

## Usage

```ts
import { Pipeline } from '@aws-blocks/pipeline';

new Pipeline(stack, 'Pipeline', {
  source: {
    repo: 'my-org/my-app',
    connectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/abc',
  },
  branches: [
    {
      branch: 'main',
      stages: [
        { name: 'beta' },
        { name: 'prod', requireApproval: true, config: { domain: 'myapp.com' } },
      ],
    },
  ],
  stageFactory: (scope, stageConfig) => {
    new MyAppStack(scope, 'App', { env: stageConfig.env });
  },
});
```

For async stage factories (for example, `BlocksStack.create()`), use the static
`Pipeline.create()` method instead of `new Pipeline()`.

## Controlling the synth runtime

The synth step's CodeBuild runtime can be customized via `synth.partialBuildSpec`.
When omitted, the synth step declares Node.js 22 as the runtime:

```ts
import { BuildSpec } from 'aws-cdk-lib/aws-codebuild';

new Pipeline(stack, 'Pipeline', {
  // ...
  synth: {
    partialBuildSpec: BuildSpec.fromObject({
      phases: { install: { 'runtime-versions': { nodejs: 22 } } },
    }),
  },
});
```
