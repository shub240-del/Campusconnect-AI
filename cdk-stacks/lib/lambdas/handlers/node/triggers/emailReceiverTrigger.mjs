// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// emailReceiverTrigger.mjs — Inbound email trigger via SES Receipt Rule + SNS
//
// Parses inbound email event notifications, extracts sender address, subject,
// and body text, formats standard inboundMessage object, and invokes chatOrchestrator.

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import * as LambdaService from '../services/LambdaService.mjs';

const s3Client = new S3Client({ region: process.env.AWS_REGION });

export const handler = async (event, _context, callback) => {
    try {
        console.info("emailReceiverTrigger invoked");
        console.trace("Event:", JSON.stringify(event, null, 2));

        for (const record of event.Records || []) {
            let messageContent = "";
            let fromAddress = "";
            let subject = "";
            let messageId = "";

            if (record.Sns) {
                const snsData = JSON.parse(record.Sns.Message || "{}");
                console.trace("SES SNS notification:", snsData);

                const mail = snsData.mail || {};
                fromAddress = mail.source || mail.commonHeaders?.from?.[0] || "";
                subject = mail.commonHeaders?.subject || "";
                messageId = mail.messageId || record.Sns.MessageId;

                // If SES saved raw email to S3 (Receipt Rule Action: S3)
                if (snsData.receipt?.action?.bucketName && snsData.receipt?.action?.objectKey) {
                    try {
                        const s3Res = await s3Client.send(new GetObjectCommand({
                            Bucket: snsData.receipt.action.bucketName,
                            Key: snsData.receipt.action.objectKey
                        }));
                        const rawEmail = await s3Res.Body.transformToString();
                        // Extract plain text body from raw MIME (simple parser)
                        const bodyMatch = rawEmail.split(/\r?\n\r?\n/).slice(1).join("\n\n");
                        messageContent = bodyMatch.slice(0, 2000).trim();
                    } catch (s3Err) {
                        console.warn("Could not fetch raw email from S3:", s3Err.message);
                    }
                }

                // If content was directly in SNS notification
                if (!messageContent && snsData.content) {
                    messageContent = snsData.content;
                }

                if (!messageContent) {
                    messageContent = subject || "Inbound support inquiry via email";
                }
            }

            if (!fromAddress) {
                console.warn("No sender address found in email notification");
                continue;
            }

            const inboundMessage = {
                channel: "email",
                action: "process",
                replyExpected: true,
                destinationAddress: fromAddress,
                serviceAddress: process.env.SES_FROM_ADDRESS || "support@smallbiz.local",
                messageBody: messageContent,
                subject: subject,
                inboundMessageId: messageId,
                useCaseId: "support"
            };

            console.info("Invoking chatOrchestrator for email from:", fromAddress);
            await LambdaService.invoke(process.env.CHAT_ORCHESTRATOR_LAMBDA_NAME, { inboundMessage });
        }

        callback(null, "Success");
    } catch (error) {
        console.error("emailReceiverTrigger error:", error);
        callback(error);
    }
};

export default { handler };
