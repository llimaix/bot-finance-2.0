import { CfnOutput, Stack, aws_iam as iam } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Bootstrap de CI/CD — se despliega UNA sola vez con credenciales locales:
 *
 *   pnpm cdk bootstrap
 *   pnpm cdk deploy GithubOidcStack -c githubRepo=<owner>/<repo>
 *
 * Crea el OIDC provider de GitHub y un rol que solo puede asumir el workflow
 * del environment `production` de ese repo. El rol no tiene permisos directos:
 * únicamente puede asumir los roles que `cdk bootstrap` ya creó (patrón estándar,
 * sin access keys de larga vida).
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const repo = this.node.tryGetContext('githubRepo') as string;

    const provider = new iam.OpenIdConnectProvider(this, 'GithubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'finanzas-web-github-deploy',
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${repo}:environment:production`,
        },
      }),
      description: 'Rol que asume GitHub Actions (environment production) para deployar con CDK',
    });

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description: 'Configurar como variable AWS_DEPLOY_ROLE_ARN en el environment production de GitHub',
    });
  }
}
