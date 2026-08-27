# Contexto do Projeto Diffonso Climatizacao

Este arquivo e uma memoria tecnica do projeto para continuidade entre sessoes. Nao e usado pelo app em runtime.

## Objetivo

Aplicativo mobile-first para Android/navegador de celular, usado por tecnicos da Diffonso Climatizacao para gerenciar ordens de servico e preencher finalizacao de atendimento.

O app nao usa banco de dados proprio. Ele consome APIs JSON/PHP e usa armazenamento local/IndexedDB apenas para cache, rascunho e fila offline.

## Regras Principais

- Sempre tratar o app como experiencia mobile.
- Nunca mostrar "vistoria" no app. Usar "servico" ou "ordem de servico".
- O app precisa funcionar offline:
  - mudancas de status e finalizacoes ficam em fila local quando nao ha internet;
  - quando voltar internet, tenta sincronizar automaticamente;
  - usuario tambem precisa conseguir abrir lista de pendencias e excluir uma pendencia travada.
  - no APK, usar o status de rede nativo do Android; `navigator.onLine` sozinho nao e confiavel;
  - falhas de conexao ao abrir ordens salvas nao devem abrir modal de erro;
  - mostrar apenas aviso curto na tela de ordens: `Offline. Continue trabalhando; sincroniza ao reconectar.`
- Login offline:
  - apos um login real bem-sucedido online, guardar localmente uma credencial verificada para esse usuario;
  - permitir login sem internet apenas se email e senha coincidirem com uma autenticacao online anterior neste aparelho;
  - nunca tratar tentativa offline como erro tecnico da API.
- Toda requisicao para API precisa enviar:
  - `Authorization: Bearer <configurado em VITE_API_AUTHORIZATION_TOKEN>`
- Toda resposta da API vem no padrao:
  - `sucesso: true` ou `1` = sucesso;
  - `sucesso: false` ou `0` = erro;
  - sempre mostrar a mensagem real enviada pela API.
- Quando exibir erro de sincronizacao, mostrar tambem a OS relacionada, por exemplo:
  - `OS 6: A ordem de serviço não permite mais atualização.`
- Login de teste:
  - email: `ussloja@gmail.com`
  - senha: configurada localmente em `VITE_TEST_LOGIN_PASSWORD`
  - e 100% local;
  - nao pode carregar ordens reais da API;
  - nao pode enviar status/finalizacao para API real;
  - carrega somente `OS-TESTE`.

## Servidor de Desenvolvimento

O app deve ficar disponivel na porta:

```txt
5505
```

URLs locais comuns:

```txt
http://localhost:5505
http://192.168.0.15:5505
```

O Vite usa proxy `/api` em desenvolvimento para evitar CORS:

```txt
/api/login.php -> https://api.diffonsoclimatizacao.com/login.php
```

## Endpoints

Base:

```txt
https://api.diffonsoclimatizacao.com
```

### Login

```txt
POST https://api.diffonsoclimatizacao.com/login.php
```

Enviar JSON:

```json
{
  "email": "usuario@email.com",
  "senha": "senha"
}
```

Retorno esperado:

```json
{
  "sucesso": true,
  "mensagem": "Login realizado com sucesso.",
  "dados": {
    "nome": "NOME DO USUARIO",
    "id": 1
  }
}
```

### Esqueceu Senha

```txt
POST https://api.diffonsoclimatizacao.com/esqueceusenha.php
```

Enviar JSON:

```json
{
  "email": "usuario@email.com"
}
```

### Listar Ordens de Servico

```txt
POST https://api.diffonsoclimatizacao.com/ordemservicos.php
```

Enviar JSON:

```json
{
  "id_colaborador": 1
}
```

Cada ordem traz dados da ordem, cliente, servico, status e questionario.

### Buscar Dados de Uma Ordem

Ainda nao usado no fluxo principal, mas disponivel para uso futuro.

```txt
POST https://api.diffonsoclimatizacao.com/buscardadosordemservico.php
```

Enviar JSON:

```json
{
  "id_colaborador": 1,
  "id_ordem_servico": 9
}
```

### Mudar Situacao da Ordem

Usar SOMENTE nos botoes:

- Iniciar deslocamento
- Iniciar atendimento
- Suspender

Nao chamar este endpoint ao finalizar ordem.

```txt
POST https://api.diffonsoclimatizacao.com/mudarsituacaoordem.php
```

Enviar JSON:

```json
{
  "id_colaborador": 1,
  "observacao": "",
  "id_ordem_servico": 9,
  "id_situacao_ordem_servico": 2
}
```

Status:

```txt
1 = Aguardando atendimento
2 = Em deslocamento
3 = Atendimento Iniciado
4 = Suspenso
5 = Finalizado
6 = Cancelado
```

### Finalizar Ordem de Servico

Usar SOMENTE ao concluir o formulario de finalizacao.

```txt
POST https://api.diffonsoclimatizacao.com/finalizarordemservico.php
```

Enviar como:

```txt
multipart/form-data
```

Motivo: a API precisa receber midias via `$_FILES`.

Campos enviados:

```txt
$_POST["dados"]        JSON completo da finalizacao
$_POST["finalizacao"]  mesmo JSON completo da finalizacao
$_POST["fileMeta"]     JSON com metadados dos arquivos
$_FILES["midias"]      fotos/videos
$_FILES["files"]       copia compativel das fotos/videos
$_FILES["assinatura"]  assinatura.png
```

Nao definir manualmente `Content-Type` no fetch de multipart. O navegador precisa gerar o boundary.

## JSON de Finalizacao

Exemplo de estrutura enviada em `dados` e `finalizacao`:

```json
{
  "id_colaborador": 1,
  "id_ordem_servico": "9",
  "id_situacao_ordem_servico": 5,
  "id_questionario": "2",
  "observacao": "Observacao final do servico.",
  "nome_responsavel": "Nome do responsavel",
  "assinatura": "data:image/png;base64,BASE64_COMPLETO_AQUI",
  "perguntas_respostas": [
    {
      "id_pergunta": 6,
      "pergunta": "Como voce avalia o atendimento do tecnico?",
      "tipo_resposta": "radio",
      "obrigatorio": 1,
      "id_resposta": "7",
      "id_respostas": ["7"],
      "resposta": "Excelente"
    },
    {
      "id_pergunta": 8,
      "pergunta": "Quais pontos voce considera positivos no servico realizado?",
      "tipo_resposta": "checkbox",
      "obrigatorio": 2,
      "id_respostas": ["14", "15"],
      "resposta": "Pontualidade, Organizacao",
      "respostas": [
        {
          "id_resposta": "14",
          "resposta": "Pontualidade"
        },
        {
          "id_resposta": "15",
          "resposta": "Organizacao"
        }
      ]
    },
    {
      "id_pergunta": 9,
      "pergunta": "Informe a data e hora em que o servico foi concluido.",
      "tipo_resposta": "datetime",
      "obrigatorio": 1,
      "id_resposta": "",
      "id_respostas": [],
      "resposta": "2026-05-22|14:30"
    }
  ],
  "ordem": {
    "id": "9",
    "numero": "OS-9",
    "id_ordem_servico": "9",
    "id_cliente": "4",
    "cliente": "Mercado Bom Preco Ltda",
    "endereco": "Avenida Presidente Vargas, 2100 | Cidade Nova | Itu - SP | CEP 13347000",
    "id_servico": "8",
    "servico": "Troca de Compressor de Ar-Condicionado"
  },
  "questionario": {
    "id_questionario": "2",
    "titulo": "Pesquisa de Satisfacao Apos Servico de Climatizacao"
  },
  "respostas": [
    "mesmo conteudo de perguntas_respostas"
  ]
}
```

Observacoes:

- `assinatura` no JSON real vai com base64 completo, nao com reticencias.
- A assinatura tambem vai como arquivo `$_FILES["assinatura"]`.
- Midias do formulario vao em `$_FILES["midias"]` e `$_FILES["files"]`.
- `fileMeta` precisa ter `id_pergunta` e `pergunta` para cada midia, para o backend saber a qual pergunta pertence.

## Questionario

Tipos vindos da API:

```txt
RADIO      = uma opcao
CHECK      = multiplas opcoes
MIDIA      = fotos/videos
TEXTAREA   = campo textarea
TEXT       = input texto
DATA       = campo data
DATAHORA   = campo data + hora
```

Obrigatoriedade:

```txt
"1" = obrigatorio
"2" = nao obrigatorio
```

Etapas fixas do app no final do questionario:

1. Observacoes do servico
2. Nome do responsavel que acompanhou o servico
3. Assinatura do responsavel

Essas etapas fixas nao vem da API.

Campo fixo `observacao_servico` deve ser enviado como:

```json
"observacao": "texto digitado"
```

## Midias

Regras:

- Permitir varias fotos e videos.
- Permitir selecionar da galeria.
- Permitir abrir camera para foto.
- Permitir abrir camera para video.
- Mostrar miniatura/preview.
- Permitir remover midia.
- Tamanho maximo por midia: 1GB.
- Nao salvar base64 no localStorage.
- Arquivos ficam em IndexedDB como Blob.
- No envio multipart, arquivos vao via `$_FILES`.

## Assinatura

Regras:

- Ultima etapa.
- Antes dela pedir nome do responsavel.
- No mobile, pedir para virar o aparelho na horizontal.
- Ao deitar o celular, liberar area de assinatura.
- Campo deve ocupar bem a tela.
- Botao de limpar assinatura.
- Nao mostrar texto "campo obrigatorio" na etapa de assinatura.
- Evitar zoom estranho ao girar.
- Assinatura vai:
  - no JSON como data URL/base64 completo;
  - em `$_FILES["assinatura"]` como `assinatura.png`.

## Offline e Pendencias

Fila offline em IndexedDB:

```txt
database: diffonso-offline
store: queue
```

Tipos:

```txt
status_change
suspend_order
finish_order
```

Se uma pendencia travar:

- Mostrar quantidade na tela de ordens.
- `N pendente(s)` deve abrir modal com lista.
- Cada item mostra:
  - OS
  - tipo
  - tentativas
  - data/hora
  - botao Excluir
- Tambem ha botao Excluir todas.

Erros de sync devem indicar OS:

```txt
OS 9: mensagem real da API
```

No APK Android:

- chamadas ao webservice passam por `CapacitorHttp`, pois a API nao expoe CORS para a origem local do app;
- usar `@capacitor/network` para detectar conexao;
- nao registrar Service Worker/Background Sync no APK, pois esse contexto nao usa o HTTP nativo;
- a fila e sincronizada com o app aberto ao reconectar.

## Arquivos Importantes

```txt
src/main.tsx
src/services/api.ts
src/services/auth.ts
src/services/serviceOrders.ts
src/services/offlineSync.ts
src/services/mediaStore.ts
src/config/endpoints.ts
public/sw.js
src/styles.css
vite.config.ts
```

## Cuidados Para Nao Quebrar

- Nao chamar `mudarsituacaoordem.php` ao finalizar.
- Nao chamar API real para usuario `ussloja@gmail.com`.
- Nao usar `Content-Type: application/json` para finalizacao multipart.
- Nao usar base64 para armazenar midias grandes localmente.
- Nao deixar o fundo rolar quando modal esta aberto.
- Sempre levar pagina para o topo ao navegar.
- Nao deixar uma pergunta vazia quebrar a tela. Exemplo que ja aconteceu:
  - `DATAHORA` sem valor deu erro em `.split`.
- Mostrar sempre mensagem real da API quando ela retornar erro.

## Cadastro de Equipamentos

A tela inicial possui acesso ao formulario mobile em `/equipamentos/novo`.

- Lista de clientes: `POST /listaclientes.php`
- Lista de tipos: `POST /tipoequipamento.php`
- Cadastro: `POST multipart/form-data /cadastrar-equipamento.php`
- Obrigatorios: `id_clientes`, `titulo` e `id_tipo_equipamento`
- `id_colaborador` vem da sessao autenticada.
- Fotos sao opcionais, permitem selecao multipla e sao enviadas como arquivos em `fileMeta[]`.
- Se app parecer preso em erro de sync, abrir lista de pendencias e excluir a pendencia ruim.
