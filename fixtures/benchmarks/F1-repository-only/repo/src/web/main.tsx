import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { createRoot } from "react-dom/client";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { NewOrderPage } from "./pages/NewOrderPage";
import { OrderPage } from "./pages/OrderPage";
import { RegisterPage } from "./pages/RegisterPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";

const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/register", element: <RegisterPage /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/reset-password", element: <ResetPasswordPage /> },
  { path: "/orders/new", element: <NewOrderPage /> },
  { path: "/orders/:id", element: <OrderPage /> },
  { path: "/admin/users", element: <AdminUsersPage /> },
]);

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
