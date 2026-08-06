import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

// iva работает host-native (bash/файлы — на реальной ФС VPS, см. docs/deploy.md). Песочница eve
// используется только для стейджинга вложений и сидинга файлов скиллов. Пинним just-bash:
// иначе defaultBackend() авто-выбирает docker на любом хосте с docker-демоном и падает без
// собранного шаблона (SandboxTemplateNotProvisionedError). just-bash не тянет docker/KVM/2.5ГБ
// образ и детерминирован на любом VPS — единственный backend, совместимый с «$5 VPS».
export default defineSandbox({
  backend: justbash(),
});
