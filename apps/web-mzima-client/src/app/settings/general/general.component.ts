import { Component, OnInit, ViewChild } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Clipboard } from '@angular/cdk/clipboard';
import { ApiKeyResult } from '@models';
import { TranslateService } from '@ngx-translate/core';
import { SessionService, BreakpointService } from '@services';
import { mergeMap, Observable } from 'rxjs';
import { SettingsMapComponent } from './settings-map/settings-map.component';
import { MediaService, ApiKeyService } from '@mzima-client/sdk';
import { ConfigService } from '../../core/services/config.service';
import { LoaderService } from '../../core/services/loader.service';
import { LanguageService } from '../../core/services/language.service';
import { ConfirmModalService } from '../../core/services/confirm-modal.service';
import { UntilDestroy, untilDestroyed } from '@ngneat/until-destroy';

@UntilDestroy()
@Component({
  selector: 'app-general',
  templateUrl: './general.component.html',
  styleUrls: ['./general.component.scss'],
})
export class GeneralComponent implements OnInit {
  @ViewChild('mapSettings') mapSettings: SettingsMapComponent;
  public isDesktop$: Observable<boolean>;
  public generalForm: FormGroup;
  public copySuccess = false;
  siteConfig: any;
  apiKey: ApiKeyResult;
  uploadedFile?: File;

  constructor(
    private sessionService: SessionService,
    private formBuilder: FormBuilder,
    private mediaService: MediaService,
    private configService: ConfigService,
    private loader: LoaderService,
    public langService: LanguageService,
    private translate: TranslateService,
    private apiKeyService: ApiKeyService,
    private confirmModalService: ConfirmModalService,
    private clipboard: Clipboard,
    private breakpointService: BreakpointService,
  ) {
    this.isDesktop$ = this.breakpointService.isDesktop$.pipe(untilDestroyed(this));
    this.generalForm = this.formBuilder.group({
      name: ['', [Validators.required, Validators.pattern('^\\S[a-zA-Z\\s]*$')]],
      description: ['', []],
      email: ['', [Validators.email, Validators.required]],
      language: ['en', []],
      private: [false, []],
      disable_registration: [false, []],
    });
  }

  ngOnInit(): void {
    this.siteConfig = this.sessionService.getSiteConfigurations();

    this.generalForm.patchValue({
      name: this.siteConfig.name,
      description: this.siteConfig.description,
      email: this.siteConfig.email,
      language: this.siteConfig.language,
      private: this.siteConfig.private,
      disable_registration: this.siteConfig.disable_registration,
    });
    this.apiKeyService.get().subscribe((res) => {
      // FIXME: results[0]
      this.apiKey = res.results[0];
    });
    this.translate.onLangChange.subscribe((newLang) => {
      this.generalForm.controls['language'].setValue(newLang.lang);
    });
  }

  fileUploaded(event: any) {
    this.siteConfig.image_header = event.dataURI;
    this.uploadedFile = event.file;
  }

  headerImageDeleted() {
    this.siteConfig.image_header = '';
    this.uploadedFile = undefined;
  }

  public async generateApiKey(): Promise<void> {
    const confirmed = await this.confirmModalService.open({
      title: this.translate.instant('notify.api_key.change_question'),
      description: `<p>${this.translate.instant('notify.default.proceed_warning')}</p>`,
      confirmButtonText: this.translate.instant('settings.general_settings.generate_api_key'),
    });

    if (!confirmed) return;

    if (this.apiKey) {
      this.apiKeyService.update(this.apiKey.id, this.apiKey).subscribe((newKey: any) => {
        this.apiKey = newKey;
      });
    } else {
      this.apiKeyService.post({}).subscribe((newKey: any) => {
        this.apiKey = newKey;
      });
    }
  }

  save() {
    this.loader.show();
    if (this.uploadedFile) {
      this.mediaService
        .uploadFile(this.uploadedFile)
        .pipe(
          mergeMap((newImage: any) => {
            this.siteConfig.image_header = newImage.original_file_url;
            return this.updateSettings();
          }),
        )
        .subscribe({
          complete: () => {
            this.loader.hide();
          },
        });
    } else {
      this.updateSettings().subscribe({
        complete: () => {
          this.loader.hide();
        },
      });
    }
  }

  private updateSettings() {
    const siteConfig = Object.assign({}, this.generalForm.value, {
      image_header: this.siteConfig.image_header,
    });
    return this.configService.update('site', siteConfig).pipe(
      mergeMap((updatedSite) => {
        this.sessionService.setConfigurations('site', updatedSite);
        return this.configService.update('map', this.mapSettings.mapConfig);
      }),
    );
  }

  public copyToClipboard(str: string): void {
    this.copySuccess = this.clipboard.copy(str);
    setTimeout(() => (this.copySuccess = !this.copySuccess), 2000);
  }
}