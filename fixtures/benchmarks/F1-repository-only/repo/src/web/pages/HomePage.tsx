import { Link } from "react-router-dom";

export function HomePage() {
  return (
    <nav>
      <Link to="/register">Register</Link> <Link to="/login">Log in</Link> <Link to="/orders/new">New order</Link>
    </nav>
  );
}
