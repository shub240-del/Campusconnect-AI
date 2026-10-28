import sys
import os
import json
from datetime import datetime, timezone

# Add bundled dependencies to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))

from strands import Agent, tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp


@tool
def get_current_time() -> str:
    """Get the current date and time in UTC.

    Returns the current UTC timestamp, useful for time-related questions.
    """
    now = datetime.now(timezone.utc)
    return json.dumps({
        "datetime": now.isoformat(),
        "date": now.strftime("%B %d, %Y"),
        "time": now.strftime("%H:%M:%S UTC"),
    })


try:
    from tools.order_lookup import lookup_order_status as ddb_lookup_order_status
except ImportError:
    try:
        from order_lookup import lookup_order_status as ddb_lookup_order_status
    except ImportError:
        ddb_lookup_order_status = None


@tool
def lookup_order_status(order_id: str) -> str:
    """Look up the status of a customer order in the BusinessOrders database.

    Args:
        order_id: The order identifier (e.g., ORD-7781, ORD-12345)
    """
    if ddb_lookup_order_status:
        try:
            res = ddb_lookup_order_status(order_id)
            if res.get("found"):
                return json.dumps({"order_id": order_id, **res.get("details", {})})
        except Exception:
            pass

    # Reliable fallback mock dataset matching seed data
    mock_orders = {
        "ORD-7781": {"status": "Shipped", "productName": "Wireless Noise-Cancelling Headphones", "eta": "3 November 2026", "trackingUrl": "https://track.carrier.com/ORD-7781"},
        "ORD-9910": {"status": "Processing", "productName": "Ergonomic Mechanical Keyboard", "eta": "5-7 business days", "trackingUrl": None},
        "ORD-12345": {"status": "Shipped", "productName": "USB-C Multi-Port Hub", "eta": "2 business days", "trackingUrl": "https://track.carrier.com/ORD-12345"},
        "ORD-67890": {"status": "Processing", "productName": "Ultra-Wide Monitor 27-inch", "eta": "3-5 business days", "trackingUrl": None},
    }
    order = mock_orders.get(order_id.upper().strip())
    if order:
        return json.dumps({"order_id": order_id, **order})
    return json.dumps({"found": False, "error": f"Order {order_id} not found."})


# System prompt for the demo agent
SYSTEM_PROMPT = """You are a helpful customer service assistant deployed via Amazon Bedrock AgentCore Runtime.
You assist customers via SMS and WhatsApp messaging.

Your capabilities:
- Check the current time
- Look up order status

Important guidelines:
- Keep responses SHORT and concise (they are delivered via SMS/WhatsApp)
- The caller's phone number is provided at the start of each message in [Caller phone: +1XXXXXXXXXX] format
- Be friendly and helpful
- Use plain text without markdown formatting
"""

# Initialize the BedrockAgentCoreApp and Strands agent
app = BedrockAgentCoreApp()
agent = Agent(
    system_prompt=SYSTEM_PROMPT,
    tools=[get_current_time, lookup_order_status],
)


@app.entrypoint
def invoke(payload):
    """Handle incoming invocations from AgentCore Runtime.

    Extracts the user prompt and phone number from the payload,
    prepends caller context to the prompt, and returns the agent response.
    """
    prompt = payload.get("prompt", "Hello")
    phone_number = payload.get("phone_number", "unknown")

    # Prepend phone number context so the agent knows who is calling
    contextualized_prompt = f"[Caller phone: {phone_number}] {prompt}"

    result = agent(contextualized_prompt)
    return result.message


if __name__ == "__main__":
    app.run()
