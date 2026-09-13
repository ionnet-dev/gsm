import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/api/client";
import { makeRouter } from "./router";

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  const [router] = useState(() => makeRouter(queryClient));

  useEffect(() => {
    const isDark = document.documentElement.classList.contains("dark");
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    // Session expired mid-use: drop cached auth and go to login with a return path.
    const onUnauthorized = () => {
      queryClient.setQueryData(["auth", "status"], { setupRequired: false, user: null });
      const here = router.state.location.href;
      if (!here.startsWith("/login")) router.navigate({ to: "/login", search: { redirect: here } });
    };
    window.addEventListener("gsm:unauthorized", onUnauthorized);
    return () => window.removeEventListener("gsm:unauthorized", onUnauthorized);
  }, [queryClient, router]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster
          theme="dark"
          position="bottom-right"
          richColors
          closeButton
          toastOptions={{ className: "text-[13px]" }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
