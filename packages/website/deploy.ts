import { Basebox } from "@moureau/basebox";

const { BASEBOX_ANON_KEY, BASEBOX_SECRET_KEY, BASEBOX_BASE_URL } = process.env;

const dist = "./dist/ssg";
const domain = "murow.moureau.dev";
const publicKey = BASEBOX_ANON_KEY;
const apiKey = BASEBOX_SECRET_KEY;
const baseUrl = BASEBOX_BASE_URL ?? "https://basebox.moureau.dev";

const bb = new Basebox({ publicKey, baseUrl });

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
