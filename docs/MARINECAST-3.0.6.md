# MarineCast 3.0.6 verification notes

## Salmon and groundfish photos

Ocean Salmon links to the [marine-phase photo chart](https://www.fws.gov/sites/default/files/documents/07_Salmon%20Identification%20Chart.pdf), [NOAA observer photo manual](https://s3.amazonaws.com/media.fisheries.noaa.gov/2024-11/species-idguide_2024.pdf), and [ODFW gum and tail guide](https://myodfw.com/articles/it-coho-or-chinook). The chart is hosted by USFWS and credits the Washington Department of Fish and Wildlife. The source links show the available side profiles and close-ups. In-app ocean-phase photos are still pending because suitable individually cleared assets could not be verified. The ocean tab no longer uses freshwater or hatchery photos.

The River Salmon cards use a [Feather River spring Chinook photograph](https://commons.wikimedia.org/wiki/File:Chinook_salmon_(32849474990).jpg) shared by CDFW under CC BY 2.0 and the [public-domain USFWS Eagle Creek hatchery Coho photograph](https://www.fws.gov/media/jon-rather-coho-eagle-creek-nfh). The source attribution for both appears in the photo viewer.

The copper rockfish photo now depicts a [central California specimen out of water](https://commons.wikimedia.org/wiki/File:Copper_Rockfish.jpg), credited to Newtonsneurosci under CC BY-SA 4.0. The existing [rockfish audit](ROCKFISH-IDENTIFICATION-3.0.5.md) documents the other groundfish and comparison photographs. During review, the CDFW, RecFIN and ODFW guides remained useful identification references. Individual commercial extraction rights were not established for their photos. Some species still have underwater reference photos and the widow and sunset photo gaps remain.

## Updating installed apps

MarineCast sometimes registers a worker with a release query to get past a stale canonical worker response. Browsers reuse that same script URL on future update checks. The previous worker rejected any mismatch between the query and the version in the downloaded script. That also rejected a newer worker delivered to an older registered URL. If the release marker was stale at the same time, clients could stay on the older version.

The worker now rejects a script older than the requested release and accepts a newer script. It still checks that the cached shell, Rules script and data agree before activation. Checks retry when release metadata advances before the assets arrive. The previous worker URL is included in deployment verification. The existing update notice preserves the user’s place until they reload. Worker cache changes leave localStorage and the permanent launch URL alone.

The browser regression simulates an installed iPhone-sized app registered at the previous release URL and a stale release marker. A separate mixed-assets test verifies that the installed shell remains usable until the matching files arrive. The live Pages host could not be reached from this environment, so the deployment verifier was run against a local GitHub Pages-style project path. The existing main-branch workflow will verify live routes after an approved merge.
