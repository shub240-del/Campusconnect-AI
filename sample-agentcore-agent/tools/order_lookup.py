"""
order_lookup.py — AgentCore tool: lookup_order_status

Queries the BusinessOrders DynamoDB table for a given orderId.
Returns a structured plain-text status message for inclusion in AI responses.

IMPORTANT: Returns only raw database values — never adds or fabricates information.
If orderId is not found, returns None so the caller can escalate to a human.
"""

import boto3
import os
import logging

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
TABLE_NAME = os.environ.get('ORDERS_DYNAMODB_TABLE', 'BusinessOrders')


def lookup_order_status(order_id: str) -> dict:
    """
    Look up order status from the BusinessOrders DynamoDB table.

    Args:
        order_id: The order identifier (e.g. 'ORD-7781')

    Returns:
        dict with keys: found (bool), statusText (str|None), details (dict|None)
    """
    # Normalize order ID format (uppercase, strip whitespace)
    normalized_id = str(order_id).strip().upper()
    if not normalized_id.startswith('ORD-'):
        # Accept bare numbers too (e.g. "7781" → "ORD-7781")
        if normalized_id.isdigit():
            normalized_id = f'ORD-{normalized_id}'

    logger.info(f'order_lookup: querying orderId={normalized_id}')

    try:
        table = dynamodb.Table(TABLE_NAME)
        response = table.get_item(Key={'orderId': normalized_id})
    except Exception as e:
        logger.error(f'order_lookup: DynamoDB error for {normalized_id}: {e}')
        return {'found': False, 'statusText': None, 'error': str(e)}

    item = response.get('Item')
    if not item:
        logger.info(f'order_lookup: orderId={normalized_id} not found in {TABLE_NAME}')
        return {'found': False, 'statusText': None}

    # Build human-readable status from raw DB fields only — no fabrication
    status = item.get('status', 'Unknown')
    product = item.get('productName', 'your item')
    eta = item.get('eta')
    tracking = item.get('trackingUrl')

    parts = [f'Status: {status}', f'Product: {product}']
    if eta:
        parts.append(f'Estimated Delivery: {eta}')
    if tracking:
        parts.append(f'Track: {tracking}')

    status_text = ' | '.join(parts)
    logger.info(f'order_lookup: found orderId={normalized_id}: {status_text}')

    return {
        'found': True,
        'statusText': status_text,
        'details': {
            'orderId': normalized_id,
            'status': status,
            'productName': product,
            'eta': eta,
            'trackingUrl': tracking
        }
    }
