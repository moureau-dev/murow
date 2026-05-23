import { Basebox } from "@moureau/basebox";

const { BASEBOX_ANON_KEY, BASEBOX_SECRET_KEY, BASEBOX_DOMAIN, BASEBOX_BASEURL } = process.env;

const dist = "./dist";
const domain = BASEBOX_DOMAIN!;
const publicKey = BASEBOX_ANON_KEY!;
const apiKey = BASEBOX_SECRET_KEY!;
const baseUrl = BASEBOX_BASEURL ?? undefined;

const bb = new Basebox({ baseUrl, publicKey });

const main = async () => {
    console.time("Deployment time");
    const { success } = await bb
      .managed({ apiKey })
      .deploy({ dist, domain });

    if (!success) {
      console.log("Failed to deploy.");
      return;
    }

    console.log(`Deployed successfully at https://${domain}`);
    console.timeEnd("Deployment time");
}

main();
