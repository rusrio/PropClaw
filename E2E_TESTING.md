# OpenClaw AI Prop Firm - End-to-End Test Flow

Este documento describe el proceso paso a paso para probar un flujo completo del servidor Prop Firm desde cero, incluyendo el registro de un nuevo agente, el fondeo de su wallet TEE (manual o automático), y la ejecución de una operación cruzada en Hyperliquid Testnet.

---

## Paso 1: Limpiar el Entorno (Opcional pero Recomendado)

Para asegurar un inicio limpio y probar como si fuera la primera vez, detén el servidor y borra la base de datos local SQLite.

```bash
# 1. Matar procesos del servidor que estén usando el puerto 3000
kill -9 $(lsof -t -i:3000) 2>/dev/null

# 2. Borrar la base de datos (elimina todos los agentes y wallets asignadas)
rm -f data/propfirm.sqlite*
```

---

## Paso 2: Iniciar el Servidor

Inicia el servidor de la aplicación. Te recomiendo abrir una nueva terminal dedicada a esto para poder ver los logs (mensajes de consola) en tiempo real.

```bash
# Iniciar con npx tsx
npx tsx src/server.ts
```

*Asegúrate de ver un mensaje como `🚀 AI Prop Firm running on :3000` antes de continuar.*

---

## Paso 3: Generar Firma del Agente

Para solicitar acceso (`/evaluate`), necesitas una wallet externa en Hyperliquid Testnet (que simula ser la del trader humano o agente externo). El servidor requiere que **firmes un mensaje de autorización** con esa wallet para ratificar que eres el dueño.

Reemplaza `TU_PRIVATE_KEY` con la llave privada de la wallet del agente a evaluar:

```bash
# Generar la firma usando viem a través de un script directo
SIGNATURE=$(npx tsx -e '
import { privateKeyToAccount } from "viem/accounts";
const key = "0xTU_PRIVATE_KEY_AQUI"; 
const account = privateKeyToAccount(key as `0x${string}`);
const message = "OpenClaw Prop Firm: authorize " + account.address;
account.signMessage({ message }).then(sig => console.log(sig));
')

echo "Firma generada: $SIGNATURE"
```

---

## Paso 4: Evaluación y Registro (/evaluate)

Llama al endpoint `/evaluate` mandando la dirección pública y la firma. Esto evaluará si pasas el filtro, creará el registro en la base de datos de SQLite, se conectará a Openfort TEE para aprovisionar una sub-wallet segura, e intentará fondearla automáticamente depositándole desde tu Faucet.

Reemplaza `TU_DIRECCION_PUBLICA` con la dirección de la key del Paso 3:

```bash
curl -s -X POST http://localhost:3000/evaluate -H "Content-Type: application/json" -d "{
  \"hyperliquid_address\": \"0xTU_DIRECCION_PUBLICA_AQUI\",
  \"signature\": \"$SIGNATURE\"
}" | jq .
```

**🔍 IMPORTANTE:**  Maneja la respuesta:
1.  Busca el `"id"` (este será el `AGENT_ID` para interactuar más adelante).
2.  Busca el `"funded_wallet_address"`. Esta es la **Wallet TEE** real que operará en Hyperliquid.
3.  Revisa el `"faucet_status"`. Si fue "success", la wallet ya tiene $50 USDC depositados desde el Faucet. Si el estatus fue "failed", entonces hay que pasar al **Paso 5**.

---

## Paso 5: Fondeo de la Wallet TEE (Fallback Manual)

*(Si en el paso 4 el `"faucet_status"` falló, generalmente porque tu cuenta Faucet en Hyperliquid Testnet es una "Unified Account" que prohíbe envíos programáticos)*.

1.  Abre tu wallet fuente en Hyperliquid Testnet (puede hacerse desde Metamask o directamente en la web de Testnet si posees balance).
2.  **Envía fondos de Testnet (ej. 50 USDC)** a la dirección `"funded_wallet_address"` generada por el TEE en el paso anterior.
3.  **Mover a Perpetuos:** Debido a reglas de Hyperliquid API, los fondos recién recibidos caen en Spot y deben transferirse a Perpetuos para tradear (si la cuenta TEE no es unified account). Actualmente este paso requeriría usar la private key (que vive en TEE), así que ten presente que la aplicación en sí misma intentará en el futuro hacer cross-margin o los fondos deberán enviarse a un Smart Contract L1. De todos modos, para fines de Testnet enviar fondos cuenta como una activación Válida.

---

## Paso 6: Ejecutar un Trade (/trade)

Ahora que la cuenta TEE tiene fondos y el agente está aprobado, ejecuta una operación de trading. 

> *Nota: Modifica el contrato (ej: BTC), tamaño (sz), lado (is_buy) y precio (limit_px) como desees.*

```bash
# Asigna el UUID del agente que recibiste en el Paso 4
AGENT_ID="PON_AQUI_EL_ID_DEL_PASO_4"

curl -s -X POST http://localhost:3000/trade -H "Content-Type: application/json" -d "{
  \"agent_id\": \"$AGENT_ID\",
  \"coin\": \"BTC\",
  \"is_buy\": true,
  \"sz\": 0.0005,
  \"limit_px\": 150000
}" | jq .
```

*Si es exitoso, verás el objeto JSON del servidor indicando el estado "ok" devuelto por la API Exchange de Hyperliquid. Revisa tu consola del servidor para ver posibles errores (Ejem. Error por insuficientes fondos, margin errors, L1 no activada, etc).*

---

## Paso 7: Monitorear Tareas (/stats & endpoints extra)

### Ver las métricas de un agente específico
```bash
curl -s http://localhost:3000/stats/$AGENT_ID | jq .
```
Deberías ver cómo se va actualizando su `trade_count`, su `current_pnl`, y el desglose de beneficios entre el Agente (80%) y la Firma (20%).

### Ver órdenes abiertas
```bash
curl -s http://localhost:3000/open_orders/$AGENT_ID | jq .
```

### Ver posiciones abiertas
```bash
curl -s http://localhost:3000/positions/$AGENT_ID | jq .
```

---

## Tips Adicionales de Integración MVP

-   **x402 Payments:** Si comentaste los bloqueos en `server.ts` de la validación x402 (`paymentMiddleware`) podrás pegarle al servidor gratis como se demostró arriba. Para re-activarlos de cara a producción, no olvides descomentar la lógica y hacer los cobros mediante ICP L2.
-   **Problemas de "Must Deposit" en Testnet:** Las nuevas direcciones en Hyperliquid (HyperCore L1) pueden pedir un primer depósito manual on-chain para crear su state tree antes de poder tradear perps.
