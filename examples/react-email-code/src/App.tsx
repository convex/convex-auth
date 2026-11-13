import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Dashboard } from "./routes/dashboard";
import { SignIn } from "./routes/signIn";
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
          path="/signin"
          element={
            <RequireNoAuth>
              <SignIn />
            </RequireNoAuth>
          }
        />
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
        <Navigate to="/signin" replace />
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
