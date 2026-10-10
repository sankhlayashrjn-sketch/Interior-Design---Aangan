"use client";

import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider, App } from "antd";
import type { ReactNode } from "react";
import { neuTheme } from "./theme";

/** Ant Design with the Neumorphism theme, with its styles rendered on the server so there is no flash. */
export function NeuProvider({ children }: { children: ReactNode }) {
  return (
    <AntdRegistry>
      <ConfigProvider theme={neuTheme}>
        <App>{children}</App>
      </ConfigProvider>
    </AntdRegistry>
  );
}
