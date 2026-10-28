// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as apigw2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigw2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as path from "path";

export interface DashboardApiStackProps extends cdk.NestedStackProps {
    readonly interactionLogTable: dynamodb.ITable;
    readonly businessOrdersTable: dynamodb.ITable;
    readonly whatsappProcessorLambda?: lambda.IFunction;
    readonly smsProcessorLambda?: lambda.IFunction;
    readonly emailProcessorLambda?: lambda.IFunction;
    readonly apiAllowedOrigins?: string;
}

export class DashboardApiStack extends cdk.NestedStack {
    public readonly httpApi: apigw2.HttpApi;
    public readonly dashboardBucket: s3.Bucket;
    public readonly dashboardHandlerLambda: lambda.Function;

    constructor(scope: Construct, id: string, props: DashboardApiStackProps) {
        super(scope, id, props);

        // ── Dashboard API Lambda Handler ──────────────────────────────────────
        const dashboardHandler = new nodeLambda.NodejsFunction(this, "DashboardHandlerLambda", {
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, "lambdas/handlers/node/dashboardHandler.mjs"),
            timeout: cdk.Duration.seconds(30),
            memorySize: 512,
            environment: {
                INTERACTION_LOG_TABLE: props.interactionLogTable.tableName,
                BUSINESS_ORDERS_TABLE: props.businessOrdersTable.tableName,
                WHATSAPP_PROCESSOR_LAMBDA: props.whatsappProcessorLambda?.functionName || "",
                SMS_PROCESSOR_LAMBDA: props.smsProcessorLambda?.functionName || "",
                EMAIL_PROCESSOR_LAMBDA: props.emailProcessorLambda?.functionName || "",
            }
        });

        props.interactionLogTable.grantReadWriteData(dashboardHandler);
        props.businessOrdersTable.grantReadData(dashboardHandler);

        if (props.whatsappProcessorLambda) {
            props.whatsappProcessorLambda.grantInvoke(dashboardHandler);
        }
        if (props.smsProcessorLambda) {
            props.smsProcessorLambda.grantInvoke(dashboardHandler);
        }
        if (props.emailProcessorLambda) {
            props.emailProcessorLambda.grantInvoke(dashboardHandler);
        }

        this.dashboardHandlerLambda = dashboardHandler;

        // ── HTTP API for Dashboard ───────────────────────────────────────────
        const corsOrigins = props.apiAllowedOrigins
            ? props.apiAllowedOrigins.split(",").map(o => o.trim())
            : ["*"];

        const httpApi = new apigw2.HttpApi(this, "SmallBizDashboardHttpApi", {
            corsPreflight: {
                allowOrigins: corsOrigins,
                allowMethods: [
                    apigw2.CorsHttpMethod.GET,
                    apigw2.CorsHttpMethod.POST,
                    apigw2.CorsHttpMethod.PUT,
                    apigw2.CorsHttpMethod.OPTIONS
                ],
                allowHeaders: ["Content-Type", "Authorization", "X-Api-Key"],
                maxAge: cdk.Duration.days(1)
            }
        });

        const integration = new apigw2Integrations.HttpLambdaIntegration(
            "DashboardIntegration",
            dashboardHandler
        );

        httpApi.addRoutes({
            path: "/api/{proxy+}",
            methods: [
                apigw2.HttpMethod.GET,
                apigw2.HttpMethod.POST,
                apigw2.HttpMethod.PUT
            ],
            integration
        });

        this.httpApi = httpApi;

        // ── S3 Bucket for Dashboard Web Assets ────────────────────────────────
        const dashboardBucket = new s3.Bucket(this, "DashboardStaticAssetsBucket", {
            websiteIndexDocument: "index.html",
            publicReadAccess: true,
            blockPublicAccess: new s3.BlockPublicAccess({
                blockPublicAcls: false,
                blockPublicPolicy: false,
                ignorePublicAcls: false,
                restrictPublicBuckets: false
            }),
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true
        });

        this.dashboardBucket = dashboardBucket;

        // Auto-deploy dashboard SPA files into S3 bucket
        new s3deploy.BucketDeployment(this, "DeployDashboardWebsite", {
            sources: [s3deploy.Source.asset(path.join(__dirname, "../../dashboard"))],
            destinationBucket: dashboardBucket
        });

        new cdk.CfnOutput(this, "DashboardApiEndpoint", {
            value: httpApi.apiEndpoint,
            description: "SmallBiz Operator Dashboard REST API Endpoint"
        });

        new cdk.CfnOutput(this, "DashboardWebsiteUrl", {
            value: dashboardBucket.bucketWebsiteUrl,
            description: "SmallBiz Operator Dashboard Web URL"
        });
    }
}
