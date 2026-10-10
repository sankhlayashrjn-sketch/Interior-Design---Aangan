"use client";

import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider, App } from "antd";
import type { ReactNode } from "react";
import { memphisTheme } from "./theme";

/** Ant Design with the Memphis theme, with its styles rendered on the server so there is no flash. */
export function MemphisProvider({ children }: { children: ReactNode }) {
  return (
    <AntdRegistry>
      <ConfigProvider theme={memphisTheme}>
        <App>{children}</App>
      </ConfigProvider>
    </AntdRegistry>
  );
}
