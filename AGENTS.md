# Instruções para agentes

Antes de analisar ou alterar este projeto, leia integralmente [`BROKAI_TECHNICAL_MEMO.md`](./BROKAI_TECHNICAL_MEMO.md). Ele descreve o produto, arquitetura, fluxo financeiro, providers, persistência, APIs, limitações e fontes de verdade.

Regras não negociáveis:

- Brok.ai permanece exclusivamente em paper trading;
- preview e confirmação explícita continuam obrigatórios;
- LLM interpreta texto, mas não calcula nem executa operações;
- posições derivam de fills e caixa deriva do ledger;
- segredos de `.env.local` nunca entram em código, documentação, logs ou respostas;
- preserve Binance para cripto, Yahoo como fallback e precisão subcentavo;
- faça o menor diff correto e execute `npm run lint` e `npm test` antes de concluir mudanças funcionais;
- se código e memorando divergirem, valide o código-fonte e atualize o memorando no mesmo diff.
