# Diffonso Serviço 1.16

Versão Android: `1.16`, código `16`. Versão do pacote: `1.16.0`.

## Alterações

- Cada card de equipamento agora contém seu próprio botão “Detalhes da OS”, que abre a Área Técnica do equipamento correspondente. O botão geral foi removido, e a seta individual continua disponível.
- Na Área Técnica, código da etiqueta, ambiente, marca e modelo ficam sempre visíveis no bloco principal, acima do texto “Atendimento iniciado há…”. A seção expansível “Dados do equipamento” foi mantida com os demais dados completos.

Os fluxos de OS sem equipamento, datas brasileiras, questionários, fotos, assinatura, status e encerramento permanecem preservados. As alterações de exibição não removem dados armazenados nem mudam o contrato da API.

## Verificação

TypeScript, compilação web e 106 testes aprovados. Sincronização Capacitor e compilação Android aprovadas. O manifesto contém versão `1.16` e código `16`; a assinatura foi validada e permanece igual à versão anterior. Os 38 arquivos web do APK correspondem byte a byte ao build final, e a página de entrada aponta para o código com a correção final.

Os testes de navegação conferem o destino individual de cada botão e seta, a ausência de botões aninhados, os quatro campos acima do tempo de atendimento, a seção expansível preservada e a manutenção das rotas existentes.

O servidor local permanece disponível em `http://localhost:5505`. A verificação local confirmou resposta HTTP e transformação do componente atualizado. Não havia navegador de automação ou aparelho Android disponível para verificação visual e instalação física.

Arquivo: `APK PRONTO PARA INSTALAR/Diffonso-Servico-v1.16-DETALHES-POR-EQUIPAMENTO.apk`.

SHA-256 do APK: `6c8ce148fa0fc2155de8dd91d5b3a8c0f29cfdcff3d5cc49f0f169df8a700c46`.

Certificado SHA-256: `e03727772ad741f8be68c9f34790ec785d635bfcb105b8b47e8241fec2334075`.
