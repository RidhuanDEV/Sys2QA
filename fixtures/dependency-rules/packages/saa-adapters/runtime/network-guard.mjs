import net from "node:net";

net.connect = () => {
  throw new Error("disabled");
};
