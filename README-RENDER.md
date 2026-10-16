# Publicar a loja e o painel da Nane no Render

O repositório `kislhakk-ux/SALGADOS` pode hospedar a loja estática, um painel com outro endereço e uma pequena API para gravar o catálogo e as fotos no próprio GitHub. Não usa banco de dados pago. O painel exige uma senha privada e um token do GitHub guardados como variáveis secretas no Render.

## Publicar a API e o painel separado

1. Confirme que os arquivos deste pacote estão na raiz do repositório `SALGADOS`, incluindo `render.yaml`, `api/`, `admin/` e `scripts/`.
2. No Render, abra **New + → Blueprint** e conecte `kislhakk-ux/SALGADOS`, branch `main`.
3. Na configuração inicial, informe `GITHUB_TOKEN` e crie uma senha forte e exclusiva para `ADMIN_PASSWORD`. Esses campos são segredos do Render; não coloque seus valores nos arquivos do site nem envie a senha pelo chat.
4. O Blueprint cria `nane-catalog-api` e `nane-catalog-admin`. O endereço público do segundo é o link separado do painel.

### Token do GitHub para o painel

Crie um token Fine-grained nas configurações do GitHub. Selecione somente o repositório `SALGADOS`, e conceda `Contents: Read and write` (a permissão `Metadata: Read` é incluída automaticamente). Cole o token somente no campo `GITHUB_TOKEN` do Render. O painel usa esse acesso para salvar `catalog.json` e as fotos enviadas em `assets/uploads/`.

## Ligar o catálogo dinâmico à loja atual

No serviço estático já existente `SALGADOS-1`, configure:

- **Build Command:** `node scripts/configure-static.mjs`
- **Publish Directory:** `.`
- **Environment Variable:** `PUBLIC_API_URL` com o endereço de `nane-catalog-api` no Render, por exemplo `https://nane-catalog-api.onrender.com`.

Salve e faça um deploy. A loja continua mostrando o catálogo básico se a API estiver temporariamente indisponível; ao voltar, consulta os dados mais recentes.

## Como o painel funciona

- A senha protege as alterações do catálogo.
- Há listas separadas para salgados/doces/centos e bebidas.
- Você pode criar categorias, adicionar itens, alterar nome, descrição, preço, unidade, foto e visibilidade.
- Um cento pode ser cadastrado como produto com unidade `Cento (100 salgados)` e descrição com os sabores escolhidos.
- Os produtos ocultados continuam guardados no catálogo e podem ser reativados.
- O Render Free mantém os serviços sem data de expiração, mas a API gratuita pode dormir depois de um período sem acesso. A primeira abertura do painel ou atualização pode levar um pouco mais para responder.

Não configure Postgres para esta solução: o catálogo e as imagens são salvos como arquivos e commits no mesmo repositório público do site. O painel protege a edição; os dados e fotos do cardápio continuam públicos, como o restante da loja.
