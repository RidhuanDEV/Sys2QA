export default function OrderPage({ params }: { params: { id: string } }) {
  return <h1>Order {params.id}</h1>;
}
