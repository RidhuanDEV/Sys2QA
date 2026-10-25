import { useEffect, useState } from "react";

export function AdminUsersPage() {
  const [users, setUsers] = useState<Array<{ id: string; email: string; role: string }>>([]);
  useEffect(() => {
    fetch("/api/admin/users").then(async (res) => setUsers(res.ok ? await res.json() : []));
  }, []);
  return <ul>{users.map((u) => <li key={u.id}>{u.email} ({u.role})</li>)}</ul>;
}
