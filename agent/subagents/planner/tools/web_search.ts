import { disableTool } from "eve/tools";

// Второй web-слот планировщика, по той же причине, что и web_fetch.ts: выдача
// поисковика — такой же недоверенный ввод, как страница, и в узел без гейта она
// попадать не должна.
export default disableTool();
