// Ponto de entrada do motor dentro do APK.
// O Node embarcado no Android (nodejs-mobile) é a versão 18, que não expõe
// globalThis.crypto por padrão — o Baileys precisa dele.
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
require('./server');
