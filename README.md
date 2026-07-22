# Brok.ai

Terminal local de paper trading com ordens simuladas, posições, risco e histórico de patrimônio. Os dados ficam no D1/SQLite local e nenhuma ordem real é enviada.

Criador principal: **Gustavo S. M.** (`gustavosmede`).

> Para arquitetura, regras financeiras, integrações, APIs, limitações e instruções para agentes de IA, consulte o [Memorando técnico do Brok.ai](./BROKAI_TECHNICAL_MEMO.md). Para a visão de negócio, modelo multibroker, monetização e expansão global, consulte o [Memorando de negócio do Brok.ai](./BROKAI_BUSINESS_MEMO.md).

## Aviso

Brok.ai não é corretora, consultor financeiro, exchange ou custodiante. O projeto é uma interface local-first para simulação, auditoria e preparação de ordens. Qualquer integração futura com corretoras deve preservar preview, confirmação explícita e logs auditáveis.

## Rodar manualmente

Requer Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000). Enquanto essa sessão estiver ativa, o painel atualiza as cotações e registra snapshots.

## Notícias e calendário econômico

O menu **5 NOTÍCIAS** combina fontes complementares com cache local:

- FinancialJuice gratuito como feed principal de mercado, geopolítica e calendário, com atraso de 10 minutos;
- GDELT para ampliar a cobertura global e geopolítica;
- feeds oficiais do Federal Reserve, ECB, BLS e EIA, além dos registros recentes do SEC EDGAR;
- Yahoo Finance como fallback automático para cada ticker aberto na carteira;
- snapshot público da Nasdaq como fallback gratuito do calendário econômico, atualizado no máximo a cada 6 horas;
- persistência no D1/SQLite local, preservando o que já foi recebido quando a internet cair.

Uma classificação determinística marca notícias como `HIGH`, `MEDIUM` ou `LOW`. Somente eventos com sinais objetivos de impacto — por exemplo decisões de juros, inflação/emprego, conflito, sanções, falência, suspensão de negociação ou guidance de uma posição — recebem a faixa vermelha e podem ser isolados pelo filtro **ALTO IMPACTO**.

Para ativar o FinancialJuice, gere uma chave gratuita e configure uma vez:

```bash
cp .env.example .env.local
```

Edite `.env.local`, substitua `fj_replace_me` pela chave e reinicie o Brok.ai. A chave fica apenas no processo local e nunca é enviada ao navegador. No modo manual (`npm run dev`), abra outro terminal para manter o stream ativo:

```bash
npm run news:collect
```

O serviço diário instalado por `npm run collector:install` já inicia esse coletor automaticamente. Sem chave ou durante uma queda do stream, o restante do Brok.ai continua normal; GDELT, fontes oficiais e Yahoo permanecem disponíveis.

## Rodar diariamente em segundo plano no macOS

```bash
npm run collector:install
```

O comando faz o build e instala um `LaunchAgent` apenas para o usuário atual. Depois disso:

- o Brok.ai inicia automaticamente quando você entra no macOS;
- o coletor consulta as posições a cada 5 minutos mesmo com o navegador fechado;
- o stream do FinancialJuice permanece conectado quando a chave estiver configurada;
- o dashboard continua disponível em `http://localhost:3000`;
- logs ficam em `.paperdesk/logs/`.

Para remover o serviço sem apagar a carteira:

```bash
npm run collector:uninstall
```

## Ditado local de novas ordens

Instale uma vez o Whisper local (modelo multilíngue `small`, cerca de 500 MB):

```bash
npm run voice:install
```

O instalador compila o `whisper.cpp` para Apple Silicon e cria um `LaunchAgent`, então o serviço de voz volta automaticamente ao entrar no macOS. No ticket **Nova ordem**, toque no microfone, fale por até 30 segundos e toque novamente para transcrever.

- a gravação é enviada apenas ao Whisper em `127.0.0.1` e não é armazenada;
- a transcrição preenche o campo como texto editável;
- o fluxo continua por Ollama, Binance/Yahoo, preview e confirmação manual obrigatória;
- o navegador pedirá permissão para usar o microfone na primeira vez.

Para desligar o serviço sem apagar o modelo baixado:

```bash
npm run voice:uninstall
```

## Mac desligado, dormindo ou sem internet

Não são inventados preços durante o período ausente. Quando o Brok.ai volta e consegue acessar a internet, ele:

1. detecta uma lacuna maior que 15 minutos;
2. baixa barras históricas de criptomoedas pela Binance Spot e dos demais ativos pelo Yahoo Finance, com fallback automático para o Yahoo;
3. reconstrói caixa, posições e P&L usando somente o último preço conhecido em cada horário, sem olhar dados futuros;
4. grava os pontos como `MARKET_BACKFILL` e mantém a lacuna no gráfico quando algum ativo não possui cobertura suficiente.

O gráfico interrompe a linha em lacunas ainda não reconstruídas, em vez de desenhar uma diagonal enganosa. O Brok.ai tenta novamente automaticamente a cada minuto pela interface e a cada 5 minutos pelo coletor.

## Binance + Yahoo Finance

Criptomoedas com par spot em USDT, como `BTC-USD` e `ETH-USD`, usam a API pública da Binance para cotação e histórico. Não é necessária chave de API. Se o par não existir, houver limite de requisições ou a Binance estiver indisponível, o Yahoo Finance assume automaticamente. A busca de nomes/tickers e os demais tipos de ativo continuam pelo Yahoo.

## Verificação

```bash
npm run lint
npm test
```

## Licença

Apache-2.0. Consulte [LICENSE](./LICENSE).
