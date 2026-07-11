import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  TimeZone,
  aws_apigatewayv2 as apigwv2,
  aws_apigatewayv2_integrations as integrations,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_scheduler as scheduler,
  aws_scheduler_targets as targets,
} from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

const GT = TimeZone.of('America/Guatemala');

export class FinanzasStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const table = new dynamodb.TableV2(this, 'Table', {
      tableName: 'finanzas-personales',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Los secretos llegan como env vars del proceso de synth: en CI vienen del
    // environment `production` de GitHub; localmente se puede exportar antes de deployar.
    const secrets = {
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? '',
      TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY ?? '',
      ALLOWED_CHAT_ID: process.env.ALLOWED_CHAT_ID ?? '',
    };

    const commonEnv = {
      TABLE_NAME: table.tableName,
      TELEGRAM_BOT_TOKEN: secrets.TELEGRAM_BOT_TOKEN,
      ALLOWED_CHAT_ID: secrets.ALLOWED_CHAT_ID,
      // Proveedores intercambiables: cambiar de LLM/STT es cambiar estas vars
      // (en CI vienen del environment de GitHub; vacías → default con ||).
      LLM_PROVIDER: process.env.LLM_PROVIDER || 'anthropic',
      LLM_MODEL: process.env.LLM_MODEL || 'claude-haiku-4-5',
      STT_PROVIDER: process.env.STT_PROVIDER || 'aws',
    };

    const fn = (name: string, entry: string, opts: { timeout: Duration; env?: Record<string, string> }) =>
      new nodejs.NodejsFunction(this, name, {
        entry,
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: opts.timeout,
        loggingFormat: lambda.LoggingFormat.JSON,
        environment: { ...commonEnv, ...opts.env },
        bundling: {
          format: nodejs.OutputFormat.ESM,
          minify: true,
          sourceMap: false,
          // Bundlear también @aws-sdk/*: versiones deterministas del lockfile,
          // sin depender de la copia (variable) que trae el runtime.
          externalModules: [],
          // Shim para dependencias que usan require() dentro del bundle ESM
          banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        },
      });

    // ── Lambdas ────────────────────────────────────────────────────────────
    const webhookFn = fn('WebhookFn', 'src/handlers/webhook.ts', {
      // El HTTP API corta la integración a los 30s: 25s deja margen para responder el ⚠️
      timeout: Duration.seconds(25),
      env: {
        TELEGRAM_WEBHOOK_SECRET: secrets.TELEGRAM_WEBHOOK_SECRET,
        ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY,
        MINIMAX_API_KEY: secrets.MINIMAX_API_KEY,
      },
    });

    const reminderFn = fn('ReminderFn', 'src/handlers/reminder.ts', {
      timeout: Duration.seconds(30),
    });

    const monthlyFn = fn('MonthlyReportFn', 'src/handlers/monthly-report.ts', {
      timeout: Duration.seconds(120),
      env: {
        ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY,
        MINIMAX_API_KEY: secrets.MINIMAX_API_KEY,
      },
    });

    // ── Permisos mínimos ───────────────────────────────────────────────────
    table.grantReadWriteData(webhookFn);
    table.grantReadData(reminderFn);
    table.grantReadData(monthlyFn);

    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['transcribe:StartStreamTranscription'],
        // Esta acción no soporta permisos a nivel de recurso: "*" es el mínimo posible.
        resources: ['*'],
      }),
    );

    // ── Webhook HTTP ───────────────────────────────────────────────────────
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'finanzas-webhook',
    });
    httpApi.addRoutes({
      path: '/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('WebhookIntegration', webhookFn),
    });

    // ── Schedules en hora de Guatemala ─────────────────────────────────────
    new scheduler.Schedule(this, 'ReminderPrimary', {
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '17', timeZone: GT }),
      target: new targets.LambdaInvoke(reminderFn, {
        input: scheduler.ScheduleTargetInput.fromObject({ kind: 'primary' }),
        retryAttempts: 2,
      }),
      description: 'Recordatorio diario 17:00 GT',
    });

    new scheduler.Schedule(this, 'ReminderFollowup', {
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '21', timeZone: GT }),
      target: new targets.LambdaInvoke(reminderFn, {
        input: scheduler.ScheduleTargetInput.fromObject({ kind: 'followup' }),
        retryAttempts: 2,
      }),
      description: 'Seguimiento 21:00 GT si no hubo respuesta',
    });

    new scheduler.Schedule(this, 'MonthlyReport', {
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '8', day: '1', timeZone: GT }),
      target: new targets.LambdaInvoke(monthlyFn, {
        input: scheduler.ScheduleTargetInput.fromObject({ kind: 'monthly' }),
        retryAttempts: 2,
      }),
      description: 'Reporte mensual día 1, 08:00 GT',
    });

    new CfnOutput(this, 'WebhookUrl', {
      value: `${httpApi.apiEndpoint}/webhook`,
      description: 'URL para registrar con setWebhook de Telegram',
    });
  }
}
