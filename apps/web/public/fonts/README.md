# Fuentes de la vista previa de los temas

`montserrat-800-latin.woff` y `nunito-800-latin.woff` son recortes al alfabeto latino de las fuentes que usa el motor de render
(`apps/ai-worker/fonts/*.ExtraBold.ttf`, SIL OFL 1.1; las licencias van al lado). Solo sirven para la **vista previa aproximada** de los
temas en el navegador; el video final se renderiza con las fuentes completas del worker.

Se generan con `python apps/web/scripts/subset-fonts.py` (necesita `fonttools`). `SHA256SUMS` lo verifica
`apps/web/test/fonts.test.js`, y también la CI: un cambio accidental no pasa desapercibido.
