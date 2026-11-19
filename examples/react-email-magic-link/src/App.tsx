import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Dashboard } from "./routes/dashboard";
import { SignIn } from "./routes/signIn";
import { SignInWithLink } from "./routes/signInWithLink";
import "./index.css";

export function App() {
  return (
    <main>
      <Routes>
        <Route
          path="/"
          element={
            <RequireAuth>
              <Dashboard />
            </RequireAuth>
          }
        />
        <Route
          path="/sign-in"
          element={
            <RequireNoAuth>
              <SignIn />
            </RequireNoAuth>
          }
        />
        {/* The landing page for the emailed link has no auth guard: the
            user's auth state when they open a link is unpredictable. */}
        <Route path="/sign-in-with-link" element={<SignInWithLink />} />
      </Routes>
    </main>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <Navigate to="/sign-in" replace />
      </Unauthenticated>
      <Authenticated>{children}</Authenticated>
    </>
  );
}

function RequireNoAuth({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Authenticated>
        <Navigate to="/" replace />
      </Authenticated>
      <Unauthenticated>{children}</Unauthenticated>
    </>
  );
}
