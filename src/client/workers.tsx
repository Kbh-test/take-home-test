import { hydrateRoot } from "react-dom/client";

import { WorkersPage } from "../pages/WorkersPage";

const root = document.getElementById("root");
if (root) hydrateRoot(root, <WorkersPage />);
