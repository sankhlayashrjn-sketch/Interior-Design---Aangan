import { LoginForm } from "@/components/LoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className="mx-auto max-w-sm py-16">
      <h1 className="mb-6 text-title font-medium">Sign in</h1>
      <LoginForm next={next ?? "/"} />
    </div>
  );
}
