# Diffonso Serviço 1.14

Versão Android: `1.14`, código `14`. Versão do pacote: `1.14.0`.

## Causas encontradas

- O normalizador usava `order.questionario` para todos os itens. Ele ignorava o questionário individual, `nome_servico` do detalhe e parte dos dados técnicos/localização. Campos vazios no objeto externo também podiam esconder valores do equipamento aninhado.
- Os arquivos das fotos já eram guardados no IndexedDB, mas suas referências/respostas ficavam em rascunhos do localStorage. Ao iniciar, `cleanupLargeDrafts` apagava rascunhos acima de 500 KB; a restauração também eliminava referências quando uma leitura do IndexedDB falhava. Fechar o formulário limpava o estado em memória, e finalizar offline removia o rascunho antes da confirmação do servidor.
- Atualizações da listagem podiam substituir os detalhes por resumos; a abertura do questionário não aguardava os detalhes. A preparação assíncrona de uma foto podia terminar depois de uma mudança de contexto.

## Comportamento corrigido

- Existindo equipamento, o questionário é exclusivamente daquele equipamento, mesmo com `multi_equipamento=false`. Questionário nulo/ausente no equipamento significa atendimento sem questionário. Somente a OS realmente sem equipamento usa seu questionário global.
- A abertura busca e normaliza o detalhe completo. Serviço, status, questionário, respostas e ações conservam o equipamento selecionado e seu `id_ordem_servico_equipamento`. A lista continua com um card por OS e seleção dos equipamentos no interior da ordem.
- Etiqueta, ambiente, marca, modelo, número de série, endereço/local e dados técnicos são apresentados a partir do modelo central. `NÃO ENCONTRADO` continua sendo um valor válido.
- Sem equipamento ou sem questionário, o encerramento mantém observações, responsável e assinatura obrigatória. A assinatura horizontal foi preservada; toque sem traço não é aceito como assinatura. O envio também recusa assinatura vazia.
- Permanecem RADIO, CHECK/CHECKBOX, TEXT, TEXTAREA, MIDIA/MEDIA, DATA/DATE e DATAHORA/DATETIME. Obrigatório continua sendo apenas `true`, `1` ou `"1"`.
- Rascunhos agora usam o IndexedDB existente, separados por usuário, OS, equipamento, questionário e pergunta. Rascunhos antigos legíveis são migrados antes de apagar sua referência antiga.
- Fotos novas são acrescentadas, com deduplicação por identidade. Reabrir o atendimento ou trocar de pergunta não apaga as anteriores. Resultados assíncronos conservam o contexto original; fotos de outros equipamentos não são misturadas.
- Mídias remotas e locais são combinadas; URLs atualizadas do servidor prevalecem. A remoção explícita fica registrada no rascunho para impedir que a hidratação recoloque a foto removida.
- Falhas de leitura/gravação/envio preservam os dados. O rascunho só é removido após confirmação da finalização, inclusive na sincronização offline; o botão explícito de reiniciar a OS de teste também limpa seu próprio rascunho. Arquivos usados por relatórios pendentes não são apagados por navegação ou remoção visual.

## Arquivos

| Arquivo | Alteração |
| --- | --- |
| `src/services/serviceOrders.ts` | Tipos, normalização de formatos novos/legados, origem do questionário e busca de todos os equipamentos no detalhe. |
| `src/services/serviceOrderGroups.ts` | Uma OS por grupo, status agregado e reconhecimento de equipamentos legados. |
| `src/services/closingDrafts.ts` | Persistência por contexto, hidratação, concatenação, deduplicação e remoção explícita. |
| `src/services/mediaStore.ts` | Reutilização do banco existente pelo serviço de rascunhos, sem alteração de versão do banco. |
| `src/main.tsx` | Integração dos detalhes e rascunhos, navegação, campos do equipamento, mídia e validação de encerramento/assinatura. |
| `src/services/offlineSync.ts`, `public/sw.js` | Preservação das mídias, assinatura obrigatória e limpeza apenas após confirmação do backend. |
| `src/styles.css` | Preservação do visual existente e espaçamento dos detalhes do equipamento. |
| `package.json`, `package-lock.json`, `android/app/build.gradle` | Versão atualizada e comandos de testes/typecheck. |
| `scripts/test-*.cjs`, `scripts/test-service-orders.mjs`, `scripts/load-test-module.mjs`, `tests/` | Testes de regressão e utilitários sem novas dependências. |

## Verificações

- `npm run typecheck`: aprovado.
- `npm test`: 66 testes aprovados.
- `npm run build`: aprovado.
- `capacitor sync android` e `gradlew assembleDebug`: aprovados.
- `git diff --check` e verificação sintática do service worker: aprovados.
- O projeto não possui lint JavaScript/TypeScript configurado. Os avisos Android de `flatDir` e `android.overridePathCheck` já pertencem à configuração existente.

Os testes exercitam normalização, um/vários/nenhum equipamento, questionários diferentes, todos os tipos de pergunta existentes, assinatura obrigatória, foto A ao reabrir, acréscimo de B, deduplicação, isolamento de perguntas/equipamentos, remoção explícita, rascunho grande, falhas transitórias, cache, fila offline e os dois transportes de finalização. Persistência e chamadas HTTP usam simulações transacionais e mocks; nenhum atendimento real foi finalizado durante os testes.

## Limites da verificação

Não havia navegador conectado. Não foi executado teste visual de câmera, rotação e instalação em um aparelho Android. A preservação desses componentes foi conferida no código e nos testes; o APK foi compilado e sua assinatura/versão verificadas.

As amostras fornecidas não contêm uma resposta real do backend com mídias já salvas. A hidratação aceita `perguntas_respostas`/`respostas` e `midias` no formato já usado pela finalização, preservando as referências remotas. A semântica de exclusão definitiva de uma mídia remota precisa seguir o backend; não foi inventado endpoint de exclusão/upload, nem alterado o contrato dos endpoints existentes.

O APK mantém o pacote `com.diffonsoclimatizacao.servico` e a assinatura usada nos APKs anteriores. O arquivo anteriormente nomeado como 1.13 continha internamente 1.12; esta entrega identifica corretamente 1.14 no manifesto.

Arquivo: `APK PRONTO PARA INSTALAR/Diffonso-Servico-v1.14-QUESTIONARIOS-E-FOTOS.apk`.

SHA-256 do APK: `29bbc39080ef5e2b71bd2a3888f154ea00cdd2688eec51aa9404d33be598a725`.

Certificado SHA-256: `e03727772ad741f8be68c9f34790ec785d635bfcb105b8b47e8241fec2334075`.

Os 27 arquivos web incorporados ao APK foram comparados byte a byte com o build final. O APK usa o build de instalação direta (`assembleDebug`) e a chave existente do projeto.
