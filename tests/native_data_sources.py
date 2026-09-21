"""Exercise the real Swift -> bundled Node -> DuckDB path without a GUI."""
import json
import plistlib
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='vektor-native-source-') as temp:
    folder = Path(temp)
    bundle = folder / 'Harness.app' / 'Contents'
    (bundle / 'MacOS').mkdir(parents=True)
    (bundle / 'Resources').mkdir()
    (bundle / 'Resources' / 'data-runtime').symlink_to(ROOT / 'build/Vektor.app/Contents/Resources/data-runtime', target_is_directory=True)
    (bundle / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'Harness','CFBundleIdentifier':'local.vektor.test.sources','CFBundlePackageType':'APPL'}))
    source = folder / 'main.swift'
    source.write_text('''import Foundation
struct NativeError: Error { let message: String; init(_ message: String) { self.message = message } }
do {
 let input = FileHandle.standardInput.readDataToEndOfFile()
 let params = try JSONSerialization.jsonObject(with: input) as! [String: Any]
 let result = try DataSources.read(params)
 let data = try JSONSerialization.data(withJSONObject: result)
 FileHandle.standardOutput.write(data)
} catch { print(error); exit(1) }
''')
    executable = bundle / 'MacOS' / 'Harness'
    subprocess.run(['swiftc', str(source), str(ROOT / 'src/native/DataSources.swift'), '-o', str(executable)], check=True)
    subprocess.run(['node', str(ROOT / 'tests/create_data_fixtures.mjs'), str(folder)], check=True)
    result = subprocess.run([str(executable)], input=json.dumps({'format':'duckdb','path':str(folder / 'measurements.duckdb')}), text=True, capture_output=True, check=True, timeout=110)
    data = json.loads(result.stdout)
    assert data['tables'][0]['records'][0]['name'] == 'Ada', data
    assert len(data['tables'][0]['records']) == 2, data
    assert not data['tables'][0]['truncated'], data
print('native data sources: ok — Swift bridge and bundled Node/DuckDB runtime')
