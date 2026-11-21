#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { FinanzasStack } from '../lib/finanzas-stack.js';
import { GithubOidcStack } from '../lib/github-oidc-stack.js';

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1',
};

new FinanzasStack(app, 'FinanzasStack', { env });

// Stack de bootstrap: se despliega UNA sola vez con credenciales locales.
//   pnpm cdk deploy GithubOidcStack -c githubRepo=<owner>/<repo>
// Solo se materializa cuando se pasa el contexto, para no estorbar el synth normal.
if (app.node.tryGetContext('githubRepo')) {
  new GithubOidcStack(app, 'GithubOidcStack', { env });
}
