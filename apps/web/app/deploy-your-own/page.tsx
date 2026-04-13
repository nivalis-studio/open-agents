import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const DEPLOY_TEMPLATE_URL =
  "https://vercel.com/new/clone?repository-url=https://github.com/vercel-labs/open-agents";

export const metadata: Metadata = {
  title: "Deploy your own",
  description:
    "Deploy your own copy of Open Agents to sign in with your own account.",
};

export default function DeployYourOwnPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-24 text-foreground">
      <div className="flex max-w-xl flex-col items-center text-center">
        <p className="text-sm font-medium text-muted-foreground">Open Agents</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">
          Deploy your own
        </h1>
        <p className="mt-4 text-base leading-7 text-muted-foreground">
          This hosted deployment only supports sign-ins from @vercel.com email
          addresses. To use the template with your own account, deploy your own
          copy.
        </p>
        <Button asChild className="mt-8" size="lg">
          <Link href={DEPLOY_TEMPLATE_URL} rel="noreferrer" target="_blank">
            Deploy your own version of this template now
          </Link>
        </Button>
      </div>
    </main>
  );
}
