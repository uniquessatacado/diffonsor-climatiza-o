# Diffonso Serviço 1.15

Versão Android: `1.15`, código `15`. Versão do pacote: `1.15.0`.

## Alterações para o cliente

- OS sem equipamento abre diretamente a Área Técnica, sem passar por “Equipamentos da ordem”. Os detalhes são resolvidos antes da navegação, com indicação de carregamento.
- Sem equipamento, a Área Técnica exibe somente “Esta OS não tem equipamento cadastrado.” no lugar dos dados do equipamento. Informações e ações da OS continuam disponíveis.
- OS com equipamento mantém a lista e ganha o botão visível “Detalhes da OS”. Com um equipamento, abre seu atendimento; com vários, abre a Área Técnica e permite selecionar o equipamento antes de executar ações. As setas dos equipamentos continuam funcionando.
- Datas exibidas e digitadas usam `DD/MM/AAAA`, inclusive os campos de data/data e hora do questionário. O calendário permanece disponível, e o formato enviado à API continua compatível.

## Preservação dos fluxos existentes

A existência de equipamento usa identificação real; flags, IDs de vínculo de serviço e objetos vazios não criam um equipamento fictício. Identificadores de atendimento, serviço e status permanecem associados ao item correto. O cache da versão anterior é normalizado sem apagar detalhes e questionários completos quando a listagem contém apenas resumos.

As correções anteriores de fotos, rascunhos, questionários por equipamento/OS, assinatura obrigatória e sincronização do encerramento foram mantidas. Não foram criados botões de encerramento nos cards de equipamentos nem alterados endpoints.

## Verificação

- TypeScript, 106 testes de regressão e compilação web aprovados.
- Sincronização Capacitor e compilação Android (`assembleDebug`) aprovadas. Manifesto conferido: versão `1.15`, código `15`; assinatura validada e mantida igual à versão anterior.
- Os 32 arquivos web incorporados ao APK foram comparados byte a byte com o build final.
- Os testes cobrem nenhum/um/vários equipamentos, navegação antes/depois do carregamento, botão e aviso, respostas tardias, cache antigo, datas inválidas/bissextas/fusos, máscara e edição parcial, além das proteções anteriores de fotos, assinatura e fila offline.
- Os testes de componentes usam callbacks reais com simulações de renderização; não havia navegador conectado nem aparelho Android disponível para verificação visual e instalação física.

O APK de instalação direta mantém `com.diffonsoclimatizacao.servico` e a mesma chave usada na versão anterior.

Arquivo: `APK PRONTO PARA INSTALAR/Diffonso-Servico-v1.15-NAVEGACAO-E-DATAS.apk`.

SHA-256 do APK: `c166e3ee942bf7a1c2b10c69fb55d7128f0544a0435e15d0ee928dcbf085fb45`.

Certificado SHA-256: `e03727772ad741f8be68c9f34790ec785d635bfcb105b8b47e8241fec2334075`.
