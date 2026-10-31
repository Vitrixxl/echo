Pod::Spec.new do |s|
  s.name           = 'BleMesh'
  s.version        = '1.0.0'
  s.summary        = 'BLE GATT mesh transport for Écho'
  s.author         = 'Écho'
  s.homepage       = 'https://example.invalid'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
