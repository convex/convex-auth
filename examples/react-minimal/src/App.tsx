import { useAuthActions } from "@convex-dev/auth/react";
import { useSignInAnonymously } from "@convex-dev/auth/methods/anonymous/react";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { api } from "../convex/_generated/api";
import "./index.css";

export function App() {
  return (
    <main>
      <h1>Convex Auth — minimal client</h1>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <Dashboard />
      </Authenticated>
    </main>
  );
}

function SignIn() {
  const { signIn } = useSignInAnonymously(api.auth);
  return (
    <>
      <p>You are signed out.</p>
      <button onClick={() => signIn()}>Sign in anonymously</button>
    </>
  );
}

function Dashboard() {
  const { signOut } = useAuthActions();
  return (
    <>
      <p>You are signed in.</p>
      <button onClick={() => signOut()}>Sign out</button>
    </>
  );
}
