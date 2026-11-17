# Salão Bot

Atendente virtual de salão de beleza para o WhatsApp: tira dúvidas, mostra horários livres, agenda, remarca e cancela, responde com ritmo de pessoa e passa a conversa para a equipe quando a cliente pede.

Este guia tem três partes, na ordem em que você vai precisar delas:

1. [Rodar no computador](#rodar-no-computador)
2. [Testar com o simulador de WhatsApp](#testar-com-o-simulador-de-whatsapp)
3. [Ligar ao número de teste da Meta](#ligar-ao-número-de-teste-da-meta) (o WhatsApp de verdade, no seu celular)

No fim há [Problemas comuns](#problemas-comuns).

---

## Rodar no computador

**Você precisa ter instalado:**

- [Node.js](https://nodejs.org) 22 ou mais novo
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (guarda o banco de dados)
- Uma chave de API do Gemini, gerada de graça em [aistudio.google.com](https://aistudio.google.com) (botão "Get API key")

**Primeira vez:**

```bash
npm ci                 # instala as dependências
cp .env.example .env   # cria seu arquivo de configuração
```

Abra o `.env` e preencha `GOOGLE_API_KEY` com a sua chave. Para usar o simulador, ajuste também os valores do WhatsApp como mostra a seção [Testar com o simulador](#testar-com-o-simulador-de-whatsapp).

> O plano gratuito do Gemini usa as conversas para melhorar os produtos da Google. Use só dados fictícios nos testes. Para atender clientes de verdade, ative o plano pago (ver Etapa 6).

**Toda vez que for usar:**

1. Abra o Docker Desktop e espere ele ficar pronto.
2. Suba o banco: `npm run db:up`
3. Escolha como quer conversar com o bot:

| Comando | Para quê |
|---|---|
| `npm test` | Roda os testes automáticos |
| `npm run cli -- --whatsapp 5543999990000 --nome "Maria"` | Conversa com o bot no terminal, resposta na hora |
| `npm run cli -- --whatsapp 5543999990000 --ritmo` | Mesmo chat, mas com o ritmo do WhatsApp (junta mensagens, "digitando", bolhas com tempo) |
| `npm run dev:sim` | Bot + simulador de WhatsApp no navegador |

No chat do terminal: `/audio` e `/imagem` simulam mídia, `/retomar` tira a pausa de atendimento humano e `/sair` encerra. Com `--debug` aparecem o modelo de IA usado e as ferramentas que ele chamou.

Para olhar o banco: `docker compose exec postgres psql -U salao -d salao`.

---

## Testar com o simulador de WhatsApp

O simulador imita a Meta e o aplicativo do WhatsApp, para você testar sem número de verdade.

Para ele funcionar, o `.env` precisa apontar o WhatsApp para o simulador. Estes valores são inventados e só servem para isso:

```bash
WA_API_BASE_URL=http://localhost:4000
WA_API_VERSION=v25.0
WA_TOKEN=token-simulador
WA_PHONE_NUMBER_ID=100000000000001
WA_VERIFY_TOKEN=verificacao-local
WA_APP_SECRET=segredo-local
ADMIN_TOKEN=admin-local
```

Depois:

```bash
npm run dev:sim
```

Abra **http://localhost:4000** e:

1. Crie um contato (número e nome) e mande mensagens como se fosse a cliente.
2. Use 🎤 e 🖼️ para simular áudio e imagem.
3. Peça "quero falar com uma pessoa": o aviso aparece na conversa **Dona do salão (avisos)** e o bot fica em silêncio com essa cliente.
4. Em **Como equipe**, responda como alguém do salão (o bot pausa); **Devolver para o bot** faz ele voltar.
5. O painel da direita mostra os próximos agendamentos.

Ctrl+C no terminal desliga o bot e o simulador juntos.

---

## Ligar ao número de teste da Meta

Aqui o bot passa a responder no **seu WhatsApp de verdade**, usando um número de teste gratuito que a Meta oferece para desenvolvedores. Os passos seguem a documentação oficial da Meta e da Cloudflare consultada em 30/09/2026. Se alguma tela estiver com outro nome, procure pelo termo em inglês entre parênteses.

### Antes de começar

- Uma conta do Facebook (pode ser a pessoal; nada é publicado no seu perfil).
- O celular com WhatsApp que vai conversar com o bot.
- O bot rodando no computador (`npm run dev`) durante o teste.
- **Uma rede que permita o túnel.** A Meta precisa alcançar o seu computador pela internet; o Cloudflare Tunnel faz isso com uma conexão de saída pela porta **7844**. Redes de empresa costumam bloquear essa porta, e a política de TI pode não permitir. Em caso de dúvida, faça esta parte em casa ou use o roteador do celular.

### Passo 1. Conta de desenvolvedor

1. Acesse [developers.facebook.com](https://developers.facebook.com) e entre com o Facebook.
2. Clique em **Começar** (Get Started) e conclua o cadastro de desenvolvedor (a Meta pode pedir para confirmar e-mail ou celular).

### Passo 2. Criar o app

1. Em [developers.facebook.com/apps](https://developers.facebook.com/apps), clique em **Criar app** (Create App) e informe um nome (ex.: "Salão Bot Teste") e seu e-mail.
2. Em caso de uso, escolha **Conectar-se com clientes pelo WhatsApp** (Connect with customers through WhatsApp).
3. Escolha um **portfólio empresarial** (Business Portfolio) ou crie um na hora. É obrigatório nesse fluxo; um portfólio de teste serve.
4. Revise e clique em **Criar app** (Create app).

### Passo 3. Número de teste e token

1. No painel do app, abra **Personalizar caso de uso > Conectar no WhatsApp > Início rápido** (Customize use case > Connect on WhatsApp > Quickstart) e clique em **Começar a usar a API** (Start using the API).
2. Na tela de configuração da API (API Setup):
   - O **número de teste** já aparece em **De** (From). Logo abaixo está o **Phone Number ID**: copie para o `.env` em `WA_PHONE_NUMBER_ID`.
   - Anote também o **WhatsApp Business Account ID** (não vai no `.env`, mas a Meta pede em outras telas).
   - Clique em **Gerar token de acesso** (Generate access token) e copie o token para `WA_TOKEN`.
   - Em **Para** (To), cadastre o seu celular. O painel pode mandar um código para o seu WhatsApp para confirmar. Costuma haver um limite pequeno de destinatários (cerca de 5).
   - Cadastre também o celular da dona, se for outro: é para lá que vão os avisos de atendimento humano.
3. O token gerado aí é **temporário** e expira rápido (costuma durar cerca de um dia). Quando o bot começar a dar erro de autenticação, gere outro e troque no `.env`. Para não precisar trocar, veja [Token permanente (opcional)](#token-permanente-opcional).

### Passo 4. App Secret

Em **Configurações do app > Básico** (App settings > Basic), clique em **Mostrar** (Show) ao lado de **Chave secreta do app** (App secret). O painel pede a senha do Facebook. Copie para `WA_APP_SECRET`.

É com ela que o bot confere que cada mensagem veio mesmo da Meta.

### Passo 5. Preencher o `.env` com os dados da Meta

Antes de mudar, copie os valores do simulador para um comentário, para voltar a eles depois:

```bash
# --- Meta (número de teste) ---
WA_API_BASE_URL=https://graph.facebook.com
WA_API_VERSION=v25.0
WA_TOKEN=<token do Passo 3>
WA_PHONE_NUMBER_ID=<Phone Number ID do Passo 3>
WA_APP_SECRET=<App secret do Passo 4>
WA_VERIFY_TOKEN=<invente uma senha, ex.: salao-verifica-2026>
DONO_WHATSAPP=<celular da dona com DDI, só números, ex.: 5543999999999>
```

`WA_VERIFY_TOKEN` você inventa; vai repetir o mesmo valor no painel no Passo 7.

Depois suba o bot (sem o simulador): `npm run dev`. Ele deve mostrar `ouvindo na porta 3000, WhatsApp em https://graph.facebook.com/v25.0`.

### Passo 6. Abrir o túnel

1. Instale o `cloudflared`: baixe o instalador oficial [cloudflared-windows-amd64.msi](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi) e execute. (Alternativa não oficial: `winget install --id Cloudflare.cloudflared`.) Ele não se atualiza sozinho no Windows.
2. Com o bot rodando, abra **outro terminal** e rode:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

3. Em alguns segundos aparece um endereço como `https://palavras-aleatorias.trycloudflare.com`. Deixe esse terminal aberto: fechar desliga o túnel.

Não precisa de conta na Cloudflare. **O endereço muda toda vez que você roda o comando**, e aí é preciso repetir o Passo 7 com o endereço novo. O túnel rápido é feito para testes, sem garantia de ficar no ar.

### Passo 7. Configurar o webhook na Meta

1. No painel do app, abra **WhatsApp > Configuração** (Configuration). Dependendo da versão do painel, fica em **Casos de uso > Personalizar > Configuração** (Use cases > Customize > Configuration).
2. Em **URL de retorno de chamada** (Callback URL), cole o endereço do túnel com `/webhook` no fim:
   `https://palavras-aleatorias.trycloudflare.com/webhook`
3. Em **Token de verificação** (Verify token), cole o mesmo valor de `WA_VERIFY_TOKEN`.
4. Clique em **Verificar e salvar** (Verify and save). Se der certo, o painel aceita sem erro.
5. Na lista de campos do webhook, **assine o campo `messages`** (Subscribe). Sem isso, as mensagens não chegam ao bot.

### Passo 8. Primeiro teste

1. Na tela de configuração da API (Passo 3), clique em **Enviar mensagem** (Send message). O seu celular recebe o template "hello_world" do número de teste.
2. **Responda essa mensagem no celular** com um "oi". Isso abre a janela de 24 horas (explicada abaixo).
3. O bot marca como lida, mostra "digitando..." e responde. A partir daí, converse normalmente: peça horários, agende, peça uma pessoa.
4. Se a dona estiver em outro celular, peça para ela também mandar um "oi" para o número de teste no começo do teste (ver abaixo).

### A regra das 24 horas

A Meta só deixa o bot mandar mensagem livre para quem escreveu para o número **nas últimas 24 horas**. Fora disso, só modelos de mensagem aprovados (templates).

- Para as clientes isso não atrapalha: o bot só responde quem escreveu.
- **Para o aviso à dona atrapalha:** o aviso de "atendimento humano" é uma mensagem livre. Ele só chega se a dona tiver mandado alguma mensagem para o número do bot nas últimas 24 horas. Se não, o log mostra o erro 131047. No teste, basta a dona mandar um "oi" para o número no começo. A solução definitiva (aviso por template aprovado) está anotada como melhoria.

### Voltar para o simulador

Troque no `.env` os valores do WhatsApp pelos do simulador (os que você guardou no comentário) e use `npm run dev:sim`.

### Token permanente (opcional)

Para não gerar token todo dia:

1. Em [business.facebook.com/latest/settings](https://business.facebook.com/latest/settings), abra **Usuários do sistema** (System Users) e clique em **Adicionar** (+Add). Dê um nome e escolha o papel Admin.
2. Em **Atribuir ativos** (Assign assets), dê ao usuário o app (com "Gerenciar app") e a conta do WhatsApp (controle total).
3. Clique em **Gerar token** (Generate token), escolha o app, marque `business_management`, `whatsapp_business_management` e `whatsapp_business_messaging` e escolha validade **Nunca** (Never).
4. Copie para `WA_TOKEN`. Guarde esse token como uma senha.

---

## Problemas comuns

**O túnel não abre ou fica tentando conectar.**
A rede está bloqueando a porta 7844. Tente `cloudflared tunnel --protocol http2 --url http://localhost:3000`; se continuar, use outra rede (roteador do celular ou a de casa).

**"Verificar e salvar" dá erro no painel da Meta.**
- O bot está rodando? (`npm run dev` mostrando "ouvindo na porta 3000")
- O túnel está aberto e o endereço é o atual? Ele muda a cada execução.
- O endereço termina em `/webhook`?
- O Verify token do painel é idêntico ao `WA_VERIFY_TOKEN` do `.env`? Depois de mudar o `.env`, reinicie o bot.

**Mando mensagem no celular e o bot não responde.**
- O campo `messages` está assinado no webhook (Passo 7)?
- No terminal do bot apareceu alguma linha? Se não apareceu nada, a mensagem não chegou: confira túnel e webhook.
- O painel avisa que o app está em modo de desenvolvimento (Dev)? A Meta diz que alguns webhooks não são enviados nesse modo. Com o número de teste costuma funcionar, mas se nada chegar, vale verificar.

**O log do bot mostra `[webhook] assinatura inválida (401)`.**
A assinatura não confere: o `WA_APP_SECRET` está errado ou é de outro app. Copie de novo do Passo 4 e reinicie o bot.

**O log mostra `[whatsapp] falha ao enviar texto (...)` com erro de autenticação ou token.**
O token expirou (o código costuma ser 190). Gere outro no Passo 3 (ou use o permanente), troque `WA_TOKEN` e reinicie o bot.

**O log mostra `[whatsapp] falha ao enviar texto (131047)`.**
A pessoa não escreveu para o número nas últimas 24 horas. Acontece principalmente com o aviso à dona: peça para ela mandar um "oi" para o número.

**O log mostra `[webhook] mensagem ... sem telefone (BSUID) ignorada`.**
A cliente usa "nome de usuário" no WhatsApp e escondeu o número. O bot ainda não atende esse caso (anotado como melhoria).

**O log mostra `[modelo] ... indisponível, tentando o próximo`.**
A cota do plano gratuito do Gemini acabou naquele modelo; o bot tenta os outros sozinho. Se todos acabarem, a cliente recebe "vou pedir pra alguém da equipe te responder" e o contato vai para atendimento humano. A cota renova de madrugada (meia-noite no horário do Pacífico).

**O banco não conecta.**
Abra o Docker Desktop e rode `npm run db:up`.
