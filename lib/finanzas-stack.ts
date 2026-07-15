import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  TimeZone,
  aws_apigatewayv2 as apigwv2,
  aws_apigatewayv2_integrations as integrations,
  aws_budgets as budgets,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_scheduler as scheduler,
  aws_scheduler_targets as targets,
  aws_sns as sns,
  aws_sns_subscriptions as snsSubs,
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
      // El agente puede editar/borrar: restauración a cualquier punto de 35 días.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
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
      // Vacío = default por proveedor (resuelto en config.ts, no aquí).
      LLM_PROVIDER: process.env.LLM_PROVIDER || 'anthropic',
      LLM_MODEL: process.env.LLM_MODEL || '',
      LLM_MODEL_AGENT: process.env.LLM_MODEL_AGENT || '',
      LLM_PROVIDER_VISION: process.env.LLM_PROVIDER_VISION || '',
      LLM_MODEL_VISION: process.env.LLM_MODEL_VISION || '',
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
    // Arquitectura asíncrona: el webhook valida/deduplica y responde 200 al
    // instante; el trabajo real (agente, visión, voz) corre en el processor
    // con 2 minutos de presupuesto — los timeouts del HTTP API dejan de existir.
    const processorFn = fn('ProcessorFn', 'src/handlers/processor.ts', {
      // 180s: MiniMax-M3 tiene latencia variable (razona largo); el costo de
      // Lambda es por ms usado, el tope alto no cuesta nada si no se usa.
      timeout: Duration.seconds(180),
      env: {
        TELEGRAM_WEBHOOK_SECRET: secrets.TELEGRAM_WEBHOOK_SECRET,
        ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY,
        MINIMAX_API_KEY: secrets.MINIMAX_API_KEY,
      },
    });

    const webhookFn = fn('WebhookFn', 'src/handlers/webhook.ts', {
      timeout: Duration.seconds(10),
      env: {
        TELEGRAM_WEBHOOK_SECRET: secrets.TELEGRAM_WEBHOOK_SECRET,
        PROCESSOR_FUNCTION_NAME: '', // se fija abajo (evita referencia circular)
      },
    });
    webhookFn.addEnvironment('PROCESSOR_FUNCTION_NAME', processorFn.functionName);
    processorFn.grantInvoke(webhookFn);

    // El reminder también llama al LLM (coach semanal y plan de quincena).
    const reminderFn = fn('ReminderFn', 'src/handlers/reminder.ts', {
      timeout: Duration.seconds(60),
      env: {
        ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY,
        MINIMAX_API_KEY: secrets.MINIMAX_API_KEY,
      },
    });

    const monthlyFn = fn('MonthlyReportFn', 'src/handlers/monthly-report.ts', {
      timeout: Duration.seconds(120),
      env: {
        ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY,
        MINIMAX_API_KEY: secrets.MINIMAX_API_KEY,
      },
    });

    // ── Permisos mínimos ───────────────────────────────────────────────────
    table.grantReadWriteData(webhookFn); // solo el item de dedupe
    table.grantReadWriteData(processorFn);
    // reminder y monthly también escriben: acumulan su consumo de IA (USAGE#).
    table.grantReadWriteData(reminderFn);
    table.grantReadWriteData(monthlyFn);

    processorFn.addToRolePolicy(
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

    new scheduler.Schedule(this, 'DailyGuardian', {
      schedule: scheduler.ScheduleExpression.cron({ minute: '30', hour: '8', timeZone: GT }),
      target: new targets.LambdaInvoke(reminderFn, {
        input: scheduler.ScheduleTargetInput.fromObject({ kind: 'guardian' }),
        retryAttempts: 2,
      }),
      description: 'Guardián financiero diario 08:30 GT (solo habla si hay hallazgos)',
    });

    new scheduler.Schedule(this, 'WeeklySummary', {
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '20', weekDay: 'SUN', timeZone: GT }),
      target: new targets.LambdaInvoke(reminderFn, {
        input: scheduler.ScheduleTargetInput.fromObject({ kind: 'weekly' }),
        retryAttempts: 2,
      }),
      description: 'Resumen semanal domingo 20:00 GT',
    });

    new scheduler.Schedule(this, 'PaydayCheckpoint', {
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '8', day: '14,28', timeZone: GT }),
      target: new targets.LambdaInvoke(reminderFn, {
        input: scheduler.ScheduleTargetInput.fromObject({ kind: 'payday' }),
        retryAttempts: 2,
      }),
      description: 'Plan de quincena día 14 y 28, 08:00 GT (víspera de los pagos del 15 y 29)',
    });

    new scheduler.Schedule(this, 'MonthlyReport', {
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '8', day: '1', timeZone: GT }),
      target: new targets.LambdaInvoke(monthlyFn, {
        input: scheduler.ScheduleTargetInput.fromObject({ kind: 'monthly' }),
        retryAttempts: 2,
      }),
      description: 'Reporte mensual día 1, 08:00 GT',
    });

    // ── Guardas de costos ──────────────────────────────────────────────────
    // Presupuesto mensual de $10 sobre TODA la cuenta:
    //   $5 (50%)  → correo de aviso
    //   $8 (80%)  → correo de alerta temprana
    //   $10 (100%)→ correo + KILL SWITCH: se adjunta una política DENY-all a los
    //               roles de las 3 Lambdas, con lo que el bot deja de operar.
    // Nota: los datos de facturación de AWS se actualizan con horas de retraso
    // (no es un corte en tiempo real), pero a la escala de este stack el exceso
    // posible es de centavos.
    const alertEmail = process.env.BILLING_ALERT_EMAIL || 'asanchezrixtun@gmail.com';
    const budgetName = 'finanzas-web-mensual';
    const emailSubscriber = { subscriptionType: 'EMAIL', address: alertEmail };

    const monthlyBudget = new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 10, unit: 'USD' },
      },
      notificationsWithSubscribers: [50, 80, 100].map((threshold) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [emailSubscriber],
      })),
    });

    const killSwitchPolicy = new iam.ManagedPolicy(this, 'KillSwitchPolicy', {
      description:
        'Adjuntada automáticamente por el budget action al superar $10/mes: deniega todo a las Lambdas del bot',
      statements: [
        new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['*'], resources: ['*'] }),
      ],
    });

    const lambdaRoles = [webhookFn, processorFn, reminderFn, monthlyFn].map((f) => f.role!);

    const budgetActionRole = new iam.Role(this, 'BudgetActionRole', {
      assumedBy: new iam.ServicePrincipal('budgets.amazonaws.com'),
      description: 'Lo asume AWS Budgets para aplicar/retirar el kill switch',
    });
    budgetActionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
        resources: lambdaRoles.map((r) => r.roleArn),
      }),
    );

    const killSwitch = new budgets.CfnBudgetsAction(this, 'KillSwitchAction', {
      budgetName,
      actionType: 'APPLY_IAM_POLICY',
      actionThreshold: { type: 'ABSOLUTE_VALUE', value: 10 },
      notificationType: 'ACTUAL',
      approvalModel: 'AUTOMATIC',
      executionRoleArn: budgetActionRole.roleArn,
      definition: {
        iamActionDefinition: {
          policyArn: killSwitchPolicy.managedPolicyArn,
          roles: lambdaRoles.map((r) => r.roleName),
        },
      },
      subscribers: [{ type: 'EMAIL', address: alertEmail }],
    });
    killSwitch.node.addDependency(monthlyBudget);

    // ── Alarmas: los errores ya no fallan en silencio ─────────────────────
    const alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      displayName: 'finanzas-web alertas',
    });
    alertsTopic.addSubscription(new snsSubs.EmailSubscription(alertEmail));

    const monitored = [
      ['Webhook', webhookFn],
      ['Processor', processorFn],
      ['Reminder', reminderFn],
      ['Monthly', monthlyFn],
    ] as const;
    for (const [name, f] of monitored) {
      new cloudwatch.Alarm(this, `${name}ErrorsAlarm`, {
        metric: f.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `finanzas-web: errores en la Lambda ${name}`,
      }).addAlarmAction(new cwActions.SnsAction(alertsTopic));
    }

    new CfnOutput(this, 'WebhookUrl', {
      value: `${httpApi.apiEndpoint}/webhook`,
      description: 'URL para registrar con setWebhook de Telegram',
    });
  }
}
