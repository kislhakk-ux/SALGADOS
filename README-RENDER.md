# Publicar a loja e o painel da Nane

O repositório `kislhakk-ux/SALGADOS` mantém a loja atual, o painel e uma API. O HTML, o CSS e a aparência da loja são mantidos. O catálogo e as fotos continuam no GitHub; os pedidos ficam no Cloud Firestore privado. A API do Render é a única camada que lê e grava pedidos, autentica o painel e envia notificações push pelo Firebase Cloud Messaging (FCM).

## Publicar a API e ligar o painel existente

1. Crie um projeto dedicado da Nane no Firebase, habilite o Cloud Firestore no modo Native e registre o app Android com o pacote `com.nane.agenda`.
2. Baixe o `google-services.json` do app Android e coloque-o em `android/app/google-services.json`. Esse arquivo contém configurações públicas do app e é usado para compilar o APK. Nunca confunda com a chave privada de conta de serviço.
3. No Firebase, crie uma chave de conta de serviço e guarde o JSON com segurança. A chave completa deve ficar somente na variável secreta `FIREBASE_SERVICE_ACCOUNT_JSON` do Render; o ID do projeto fica em `FIREBASE_PROJECT_ID`. Nunca coloque essa chave privada no GitHub, no APK ou no chat.
4. No Render, o serviço `nane-catalog-api` usa o Blueprint deste repositório. Configure também `GITHUB_TOKEN` e uma senha forte para `ADMIN_PASSWORD`; `SESSION_SECRET` é gerado pelo Blueprint.
5. No serviço estático atual `SALGADOS-1`, use o comando de build `node scripts/configure-static.mjs`, publique `.` e configure `PUBLIC_API_URL` com `https://nane-catalog-api.onrender.com`. O painel abre em `/admin/` no mesmo domínio da loja. A API grava e lê os pedidos no Firestore e envia um alerta FCM para o app quando chega agendamento novo.

As regras em `firestore.rules` bloqueiam acesso direto de clientes; o servidor usa a conta de serviço e as rotas REST autenticadas.

### Plano gratuito e limites

O Firestore Spark inclui atualmente uma cota gratuita por dia/mês; quando a cota diária de Firestore é atingida, a operação afetada fica indisponível até o próximo ciclo, sem cobrança automática no Spark. Confira os [limites gratuitos do Firestore](https://firebase.google.com/docs/firestore/pricing) e os [planos do Firebase](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans).

O Render Free pode dormir após um período sem acessos e levar um pouco para acordar; as horas gratuitas de serviços web são compartilhadas pela conta. O app recebe aviso push para novo pedido e também sincroniza em segundo plano como alternativa. Os lembretes de 24 e 12 horas são alarmes locais exatos no Android, e exigem permissão de notificações/alarmes. Se o celular estiver desligado ou sem internet, os avisos push podem atrasar; alarmes locais já programados continuam no aparelho.

### Token do GitHub para o painel

Crie um token Fine-grained nas configurações do GitHub. Selecione somente o repositório `SALGADOS`, e conceda `Contents: Read and write` (a permissão `Metadata: Read` é incluída automaticamente). Cole o token somente no campo `GITHUB_TOKEN` do Render. O painel usa esse acesso para salvar `catalog.json` e as fotos enviadas em `assets/uploads/`.

## Configuração do site e painel no mesmo domínio

No serviço estático já existente `SALGADOS-1`, confira:

- **Build Command:** `node scripts/configure-static.mjs`
- **Publish Directory:** `.`
- **Environment Variable:** `PUBLIC_API_URL` com o endereço de `nane-catalog-api` no Render, por exemplo `https://nane-catalog-api.onrender.com`.

Salve e faça um deploy. O script configura tanto a loja quanto o painel com o mesmo endereço de API. A loja continua mostrando o catálogo básico se a API estiver temporariamente indisponível; ao voltar, consulta os dados mais recentes.

## Como o painel funciona

- A senha protege as alterações do catálogo.
- Há listas separadas para salgados/doces/centos e bebidas.
- O banner ilustrado do cardápio no fim da loja também pode ser atualizado pelo painel, com prévia e restauração da imagem original.
- Você pode criar categorias, adicionar itens, alterar nome, descrição, preço, unidade, foto e visibilidade.
- Um cento pode ser cadastrado como produto com unidade `Cento (100 salgados)` e descrição com os sabores escolhidos.
- Os produtos ocultados continuam guardados no catálogo e podem ser reativados.
- O catálogo e as fotos continuam públicos, como o restante da loja. Os pedidos são protegidos pelo login do painel e ficam no banco privado.
