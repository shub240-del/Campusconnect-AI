# SmallBiz AI Support Hub — API Reference

## 1. Operator Dashboard REST API

The Dashboard API is exposed via Amazon API Gateway HTTP API and backed by the `dashboardHandler` Lambda. It enables real-time ticket management, conversation auditing, manual operator intervention, and order verification.

Base URL: `https://[api-id].execute-api.[region].amazonaws.com`

---

### 1.1 `GET /api/stats`
Retrieves aggregated statistics across all customer interactions.

**Request:**
```http
GET /api/stats HTTP/1.1
Host: [api-id].execute-api.[region].amazonaws.com
```

**Response (200 OK):**
```json
{
  "total": 142,
  "open": 5,
  "escalated": 3,
  "resolved": 134,
  "rateLimited": 1,
  "optOuts": 2
}
```

---

### 1.2 `GET /api/interactions`
Lists customer interaction tickets with optional status filtering.

**Query Parameters:**
| Parameter | Type | Required | Description |
|:---|:---|:---|:---|
| `status` | string | No | Filter by ticket status: `OPEN`, `ESCALATED`, `RESOLVED`, `ALL` (default: `ALL`) |
| `limit` | integer | No | Maximum number of records to return (default: 50, max: 100) |

**Response (200 OK):**
```json
{
  "count": 2,
  "interactions": [
    {
      "interactionId": "int-7781-a1b2",
      "timestamp": 1761899120000,
      "customerId": "+447700900123",
      "channel": "whatsapp",
      "direction": "inbound",
      "status": "ESCALATED",
      "source": "keyword_escalation",
      "messageBody": "My parcel arrived completely broken, I want an immediate refund!",
      "escalationReason": "Escalation keyword: \"refund\"",
      "sessionId": "ses-3391"
    },
    {
      "interactionId": "int-9910-c3d4",
      "timestamp": 1761895520000,
      "customerId": "+447700900456",
      "channel": "sms",
      "direction": "outbound",
      "status": "RESOLVED",
      "source": "KB+AgentCore",
      "messageBody": "Your order ORD-7781 has shipped and is estimated for delivery on Nov 3, 2026.",
      "deliveryMessageId": "msg-00129",
      "sessionId": "ses-8821"
    }
  ]
}
```

---

### 1.3 `GET /api/interaction/{id}`
Retrieves the complete message history and metadata for a specific interaction thread.

**Path Parameters:**
- `id` (string): The interaction unique identifier.

**Response (200 OK):**
```json
{
  "interactionId": "int-7781-a1b2",
  "customerId": "+447700900123",
  "channel": "whatsapp",
  "status": "ESCALATED",
  "escalationReason": "Escalation keyword: \"refund\"",
  "createdAt": 1761899120000,
  "events": [
    {
      "timestamp": 1761899120000,
      "direction": "inbound",
      "messageBody": "My parcel arrived completely broken, I want an immediate refund!"
    },
    {
      "timestamp": 1761899122000,
      "direction": "outbound",
      "messageBody": "Thank you for reaching out. I'm connecting you with a member of our support team who will be in touch shortly."
    }
  ]
}
```

---

### 1.4 `POST /api/interaction/{id}/reply`
Allows an operator to manually send a reply message to the customer over their active channel (WhatsApp, SMS, or Email).

**Request Body:**
```json
{
  "message": "Hi there! I have reviewed your case and processed a replacement shipment right away. Your new tracking number is ORD-7781-REP.",
  "channel": "whatsapp",
  "destinationAddress": "+447700900123",
  "operatorId": "op-sarah"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "interactionId": "int-7781-a1b2",
  "status": "REPLIED",
  "deliveryMessageId": "msg-wa-44819"
}
```

---

### 1.5 `PUT /api/interaction/{id}/resolve`
Marks an escalated or open ticket as resolved.

**Request Body:**
```json
{
  "operatorId": "op-sarah",
  "note": "Customer satisfied with replacement tracking"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "interactionId": "int-7781-a1b2",
  "status": "RESOLVED",
  "resolvedAt": 1761901200000
}
```

---

### 1.6 `GET /api/orders`
Inspects business orders stored in the `BusinessOrders` DynamoDB table.

**Response (200 OK):**
```json
{
  "count": 3,
  "orders": [
    {
      "orderId": "ORD-7781",
      "customerId": "cust-01",
      "status": "Shipped",
      "productName": "Wireless Noise-Cancelling Headphones (Black)",
      "eta": "Nov 3, 2026",
      "trackingUrl": "https://tracking.example.com/ORD-7781"
    }
  ]
}
```

---

## 2. Inbound Channel Payloads

### WhatsApp Webhook via AWS End User Messaging Social Messaging
When a customer sends a message on WhatsApp, EUM receives the Meta Cloud API webhook and publishes to SNS:
```json
{
  "whatsAppWebhookEntry": "{\"changes\":[{\"value\":{\"messages\":[{\"from\":\"447700900123\",\"id\":\"wamid.HBg...\",\"text\":{\"body\":\"Where is order ORD-7781?\"}}]}}]}"
}
```

### SMS 2-Way Payload via AWS End User Messaging SMS
```json
{
  "originationNumber": "+447700900123",
  "destinationNumber": "+12065550100",
  "messageBody": "Where is order ORD-7781?",
  "inboundMessageId": "sms-in-9921"
}
```

### Inbound Email via Amazon SES
Delivered via SES S3 action and SNS notification:
```json
{
  "mail": {
    "source": "customer@example.com",
    "commonHeaders": {
      "subject": "Question about my return",
      "from": ["customer@example.com"]
    }
  }
}
```
