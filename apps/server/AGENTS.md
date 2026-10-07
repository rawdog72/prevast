# Game server

Use root scripts/server.ps1 or npm server commands for build and launch. The current Visual Studio project is apps/server/prevast_server.vcxproj; the solution is prevast.slnx.

Internal headers and implementations live together in src/{core,network,world,gameplay,content,persistence}. Includes are relative to src. Update the project and filters when adding a translation unit.

Content belongs to root data/, compiler output to root build/ and dist/, and state to runtime/<profile>. The executable reads config.lua from its working directory. Never run a test against another profile's storage or overwrite its config.

Follow the root CONTRIBUTING.md and data/README.md.
