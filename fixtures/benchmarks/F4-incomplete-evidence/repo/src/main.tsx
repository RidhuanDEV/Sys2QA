import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { CartPage } from "./pages/CartPage";
import { LoyaltyPage } from "./pages/LoyaltyPage";
import { loadRuntimeConfig } from "./runtimeConfig";

const config = await loadRuntimeConfig();
const router = createBrowserRouter([
  { path: "/cart", element: <CartPage /> },
  ...(config.loyaltyProgram ? [{ path: "/loyalty", element: <LoyaltyPage /> }] : []),
]);
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
