import React from "react";

export function Badge({ builtin, children }) {
  return <span className={"badge " + (builtin ? "builtin" : "external")}>{children}</span>;
}
