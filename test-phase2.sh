#!/bin/bash
echo "1. Registering new agent..."
AGENT_PAYLOAD=$(curl -s -X POST http://localhost:3000/evaluate -H "Content-Type: application/json" -d '{"hyperliquid_address":"0x084675DB8E8a7cACEC514c5928D4e1A5c0a0F73D","signature":"0xb4887a575db2ae20efb32531c990ac0af1bfd851be01481094dcec0afe04ae897f4a019ab17b4c1152d56587833889b41cc3b06b61f51a6c2964de70633d21031c"}')

# Use python to extract agent_id reliably
AGENT_ID=$(python3 -c "import sys, json; print(json.loads(sys.argv[1]).get('agent', {}).get('id', ''))" "$AGENT_PAYLOAD")

echo "Agent ID: $AGENT_ID"
curl -s "http://localhost:3000/positions/$AGENT_ID"
echo ""
curl -s "http://localhost:3000/open_orders/$AGENT_ID"
echo ""
curl -s "http://localhost:3000/stats/$AGENT_ID"
echo ""
