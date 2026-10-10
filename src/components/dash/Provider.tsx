"use client";

import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider, App } from "antd";
import type { ReactNode } from "react";
import { dashTheme } from "./theme";

/** Ant Design with the dark dashboard theme, with its styles rendered on the server so there is no flash. */
export function DashProvider({ children }: { children: ReactNode }) {
  return (
    <AntdRegistry>
      <ConfigProvider theme={dashTheme}>
        <App>{children}</App>
      </ConfigProvider>
    </AntdRegistry>
  );
}
