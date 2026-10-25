import { execFileSync } from "node:child_process";

export function resolveReleaseTag(env = process.env) {
  if (env.TINYAGENT_RELEASE_TAG) {
    return env.TINYAGENT_RELEASE_TAG;
  }
  if (env.GITHUB_SHA) {
    return env.GITHUB_SHA;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "manual";
  }
}

export function pinImageToRelease(image, releaseTag) {
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return `${image.slice(0, lastColon + 1)}${releaseTag}`;
  }
  return `${image}:${releaseTag}`;
}
