# Third-party Components

The MIT license covers original PC Control Plane code only, not third-party
products, trademarks, services or redistributed runtimes.

This snapshot bundles no vendor binaries, Node runtime, WebView2 runtime,
Playwright package, hardware-monitor driver, font package or game asset.

The desktop project references Microsoft.Web.WebView2 and
System.ServiceProcess.ServiceController through NuGet. Inspect their exact
package licenses and redistribution requirements before building a distribution.
Browser tests may use Playwright, which is separately obtained and licensed.
Node.js and .NET have their own runtime terms.

The interface uses locally authored markup and inline graphics in this snapshot.
Any future externally sourced icons must include their applicable copyright
and permission notices. Existing third-party notices must never be stripped
merely to make the project appear original.

Product names used for detection or interoperability identify their respective
owners and do not imply affiliation or endorsement.
