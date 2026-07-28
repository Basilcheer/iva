import { eveChannel } from "eve/channels/eve";
import { createEveAuth } from "../lib/eve-auth.js";

export default eveChannel({
  auth: createEveAuth(),
});
